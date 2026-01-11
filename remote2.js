// remote2.js
// Goal: Add a safe "Action Runner" + LG (WOL + optional webOS) + Speech Router (text first, whisper fallback)
// WITHOUT breaking the old stable behavior/endpoints from remote.js.
//
// Notes:
// - Old routes kept: /api/ping, /key/:name, /text, /voice-save, /say, /api/log, /
// - New routes added: /api/execute, /api/command, /api/capabilities, /api/devices
// - NO "public exec". Only whitelisted actions.
// - Whisper remains a fallback when client can't provide recognized text.
// - LG webOS control is optional (requires `ws` package). WOL works without extra deps.
//
// Comments are in English (per preference). ES6 style.

const https = require("https");
const http = require("http");
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const dgram = require("dgram");
const crypto = require("crypto");
const { spawn } = require("child_process");

// ===== BOOT =====
console.log("REMOTE2 BOOT v123000+", new Date().toISOString());

const app = express();

// ===== CONFIG =====
const PORT = Number(process.env.PORT || 4879); // remote.js keeps 4878, remote2 defaults to 4879

// --- Security (optional, safe by default) ---
// If REMOTE_TOKEN is set, the new endpoints require Authorization: Bearer <token> (or ?token=...).
// Old endpoints are NOT forced by default to avoid breaking existing clients.
// You can turn on strict mode later with STRICT_AUTH=1.
const REMOTE_TOKEN = process.env.REMOTE_TOKEN || "";
const STRICT_AUTH = process.env.STRICT_AUTH === "1";

// Android / ADB
const ADB = process.env.ADB_BIN || "adb";
const DEVICE = process.env.ADB_DEVICE || "192.168.100.84:5555";

// Files
const TMP_DIR = process.env.TMP_DIR || "tmp";
const VOICE_DIR = process.env.VOICE_DIR || "voice";

// Whisper.cpp (fallback STT)
const WHISPER_BIN = process.env.WHISPER_BIN || "whisper";
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || path.join(__dirname, "models", "ggml-base.bin");
const WHISPER_LANG = process.env.WHISPER_LANG || "ru"; // "" for auto-detect

const LAST_WEBM = path.join(VOICE_DIR, "last.webm");
const LAST_WAV = path.join(VOICE_DIR, "last.wav");
const LAST_TXT = path.join(VOICE_DIR, "last.wav.txt");

// HTTPS certs (try env first, fallback to the old filenames)
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || path.join(__dirname, "192.168.100.85-key.pem");
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || path.join(__dirname, "192.168.100.85.pem");

// LG defaults (can be overridden by env or devices.json)
const LG_DEFAULT = {
  name: "lg",
  ip: process.env.LG_IP || "", // e.g. 192.168.1.50
  mac: process.env.LG_MAC || "", // e.g. AA:BB:CC:DD:EE:FF
  wolPort: Number(process.env.LG_WOL_PORT || 9),
  wolBroadcast: process.env.LG_WOL_BROADCAST || "", // e.g. 192.168.1.255 (optional)
  // webOS remote (optional)
  webosPort: Number(process.env.LG_WEBOS_PORT || 3000),
  // clientKey is stored after pairing (devices.json). Can be set via env too.
  clientKey: process.env.LG_CLIENT_KEY || "",
};

// Devices config file (optional)
const DEVICES_PATH = process.env.DEVICES_PATH || path.join(__dirname, "devices.json");

// ===== ANDROID KEYS =====
const KEYS = {
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  ok: 23,
  back: 4,
  home: 3,
  menu: 82,
  volup: 24,
  voldown: 25,
  mute: 164,
};

// ===== LOG =====
const ts = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const log = (sid, stage, msg, extra = "") => {
  const tail = extra ? ` ${extra}` : "";
  console.log(`[${ts()}] [${sid}] ${stage} ${msg}${tail}`);
};

const getSid = (req) => String(req.query.sid || req.headers["x-sid"] || "nosid");

// ===== UTILS =====
const safeUnlink = (p) => {
  try {
    fs.unlinkSync(p);
  } catch {}
};

const runBin = (bin, args, opts = {}) =>
  new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => resolve({ ok: false, error: e }));
    p.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });

const replaceFile = (src, dst) => {
  const tmp = `${dst}.tmp`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
};

const escapeForAdbText = (s) =>
  String(s)
    .replace(/\n/g, " ")
    .replace(/%/g, "%25")
    .replace(/ /g, "%s")
    .replace(/"/g, '\\"');

// ===== DEVICES (load/save) =====
const loadDevices = () => {
  try {
    if (fs.existsSync(DEVICES_PATH)) {
      const raw = fs.readFileSync(DEVICES_PATH, "utf8");
      const json = JSON.parse(raw);
      return json && typeof json === "object" ? json : {};
    }
  } catch (e) {
    console.error("[DEVICES] load failed:", e?.message || e);
  }
  return {};
};

const saveDevices = (devices) => {
  try {
    const tmp = `${DEVICES_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(devices, null, 2));
    fs.renameSync(tmp, DEVICES_PATH);
    return true;
  } catch (e) {
    console.error("[DEVICES] save failed:", e?.message || e);
    return false;
  }
};

// Normalize device state
const getDeviceState = () => {
  const stored = loadDevices();
  const lg = { ...LG_DEFAULT, ...(stored.lg || {}) };

  // We keep Android as config-only for now
  const android = {
    name: "android",
    adb: { bin: ADB, device: DEVICE },
    ...(stored.android || {}),
  };

  return { android, lg };
};

// ===== AUTH =====
const extractToken = (req) => {
  const q = String(req.query.token || "");
  if (q) return q;

  const h = String(req.headers.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();

  return "";
};

const requireAuth = (req, res, next) => {
  // If no token is configured, do not block.
  if (!REMOTE_TOKEN) return next();

  const t = extractToken(req);
  if (t && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(REMOTE_TOKEN))) return next();

  return res.status(401).json({ ok: false, error: "unauthorized" });
};

// Optionally protect ALL routes (do not enable by default)
if (STRICT_AUTH) app.use(requireAuth);

// ===== ADB =====
let adbLock = null;

const isConnected = async () => {
  const r = await runBin(ADB, ["devices"]);
  return r.ok && r.stdout.includes(`${DEVICE}\tdevice`);
};

const ensureAdb = async () => {
  if (adbLock) return adbLock;
  adbLock = (async () => {
    try {
      if (await isConnected()) return true;
      await runBin(ADB, ["connect", DEVICE]);
      return isConnected();
    } finally {
      adbLock = null;
    }
  })();
  return adbLock;
};

const adbShell = async (args) => {
  const ok = await ensureAdb();
  if (!ok) return { ok: false, error: "adb_not_connected" };
  const r = await runBin(ADB, ["-s", DEVICE, "shell", ...args]);
  if (!r.ok) return { ok: false, error: r.stderr || "adb_shell_fail" };
  return { ok: true };
};

// ===== LG: WOL =====
const normalizeMac = (mac) =>
  String(mac || "")
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");

const buildMagicPacket = (mac) => {
  const m = normalizeMac(mac);
  if (m.length !== 12) return null;

  const macBuf = Buffer.from(m, "hex");
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);

  for (let i = 0; i < 16; i++) {
    macBuf.copy(packet, 6 + i * 6);
  }
  return packet;
};

const guessBroadcastFromIp = (ip) => {
  // Simple /24 guess: 192.168.1.50 -> 192.168.1.255
  const parts = String(ip || "").trim().split(".");
  if (parts.length !== 4) return "";
  parts[3] = "255";
  return parts.join(".");
};

const sendWol = async ({ mac, broadcast, port }) =>
  new Promise((resolve) => {
    const packet = buildMagicPacket(mac);
    if (!packet) return resolve({ ok: false, error: "bad_mac" });

    const bc = broadcast || "";
    const p = Number(port || 9);

    const socket = dgram.createSocket("udp4");
    socket.on("error", (err) => {
      try {
        socket.close();
      } catch {}
      resolve({ ok: false, error: err?.message || "wol_socket_error" });
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {}

      const target = bc || "255.255.255.255";
      socket.send(packet, 0, packet.length, p, target, (err) => {
        try {
          socket.close();
        } catch {}
        if (err) return resolve({ ok: false, error: err?.message || "wol_send_error" });
        resolve({ ok: true, target, port: p });
      });
    });
  });

// ===== LG: webOS (optional via ws) =====
let WS = null;
try {
  // eslint-disable-next-line global-require
  WS = require("ws");
} catch {
  WS = null;
}

// Basic webOS client for simple commands.
// This is intentionally minimal and safe; pairing flow can be added later.
const webosRequest = async ({ ip, port, clientKey, uri, payload = {} }) => {
  if (!WS) return { ok: false, error: "ws_not_installed" };
  if (!ip) return { ok: false, error: "lg_ip_missing" };

  const wsUrl = `ws://${ip}:${port || 3000}`;
  const id = `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  return new Promise((resolve) => {
    const ws = new WS(wsUrl);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ ok: false, error: "webos_timeout" });
    }, 3500);

    const done = (result) => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {}
      resolve(result);
    };

    ws.on("open", () => {
      const msg = {
        id,
        type: "request",
        uri,
        payload: {
          ...payload,
        },
      };

      // Include client-key if we have it (after pairing).
      if (clientKey) {
        msg.payload["client-key"] = clientKey;
      }

      ws.send(JSON.stringify(msg));
    });

    ws.on("message", (data) => {
      let obj = null;
      try {
        obj = JSON.parse(String(data));
      } catch {
        return;
      }

      // If webOS asks for pairing, it usually responds with "registered": false or "pairingType".
      // We do NOT auto-approve anything here; just report it.
      if (obj?.id === id) {
        if (obj?.type === "response" && obj?.payload) {
          return done({ ok: true, response: obj });
        }
        return done({ ok: true, response: obj });
      }
    });

    ws.on("error", (err) => done({ ok: false, error: err?.message || "webos_error" }));
    ws.on("close", () => {
      // If it closed without response, keep timeout handling
    });
  });
};

// Convenience wrappers (non-pairing)
const lgVolumeUp = async (lg) =>
  webosRequest({
    ip: lg.ip,
    port: lg.webosPort,
    clientKey: lg.clientKey,
    uri: "ssap://audio/volumeUp",
  });

const lgVolumeDown = async (lg) =>
  webosRequest({
    ip: lg.ip,
    port: lg.webosPort,
    clientKey: lg.clientKey,
    uri: "ssap://audio/volumeDown",
  });

const lgMuteToggle = async (lg) =>
  webosRequest({
    ip: lg.ip,
    port: lg.webosPort,
    clientKey: lg.clientKey,
    uri: "ssap://audio/toggleMute",
  });

const lgPowerOff = async (lg) =>
  webosRequest({
    ip: lg.ip,
    port: lg.webosPort,
    clientKey: lg.clientKey,
    uri: "ssap://system/turnOff",
  });

// ===== INIT =====
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(VOICE_DIR, { recursive: true });

app.use(express.json({ limit: "512kb" }));
app.use(express.static(__dirname));

// ACCESS LOG (only important routes)
app.use((req, res, next) => {
  if (
    req.url.startsWith("/voice-save") ||
    req.url.startsWith("/api/log") ||
    req.url.startsWith("/api/execute") ||
    req.url.startsWith("/api/command")
  ) {
    console.log("[HIT]", req.method, req.url);
  }
  next();
});

// ===== ROUTES (OLD) =====

// health ping (used by frontend)
app.get("/api/ping", async (req, res) => {
  try {
    const ok = await ensureAdb(); // tries to connect if not connected
    res.json({ ok: !!ok });
  } catch (e) {
    res.json({ ok: false, error: e?.message || "ping_fail" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// client logs
app.post("/api/log", (req, res) => {
  const sid = getSid(req);
  log(sid, "CLIENT", req.body?.msg || "log", JSON.stringify(req.body?.extra || ""));
  res.send("ok");
});

// buttons
app.get("/key/:name", async (req, res) => {
  const code = KEYS[req.params.name];
  if (!code) return res.status(400).send("bad key");
  const r = await adbShell(["input", "keyevent", String(code)]);
  if (!r.ok) return res.status(500).send(r.error);
  res.send("ok");
});

// text
app.get("/text", async (req, res) => {
  const t = req.query.t || "";
  if (!t) return res.status(400).send("missing t");
  const safe = escapeForAdbText(t);
  const r = await adbShell(["input", "text", safe]);
  if (!r.ok) return res.status(500).send(r.error);
  res.send("ok");
});

// ===== VOICE (OLD, unchanged behavior) =====
const upload = multer({ dest: TMP_DIR });

app.post("/voice-save", upload.single("audio"), async (req, res) => {
  const sid = getSid(req);

  if (!req.file) {
    log(sid, "UPLOAD", "no_file");
    return res.sendStatus(400);
  }

  log(sid, "UPLOAD", "recv", `bytes=${req.file.size}`);

  // overwrite last.webm
  replaceFile(req.file.path, LAST_WEBM);
  safeUnlink(req.file.path);

  log(sid, "UPLOAD", "saved", "last.webm");

  // ffmpeg -> wav
  log(sid, "FFMPEG", "start");
  const ff = await runBin("ffmpeg", ["-y", "-i", LAST_WEBM, "-ar", "16000", "-ac", "1", LAST_WAV]);
  if (!ff.ok) {
    log(sid, "FFMPEG", "fail", ff.stderr.slice(-200));
    return res.sendStatus(500);
  }
  log(sid, "FFMPEG", "ok", "last.wav");

  // whisper
  safeUnlink(LAST_TXT);

  if (!fs.existsSync(WHISPER_MODEL)) {
    log(sid, "WHISPER", "model_missing", WHISPER_MODEL);
    return res.status(500).json({ ok: false, error: "whisper_model_missing" });
  }

  const wArgs = ["-m", WHISPER_MODEL, LAST_WAV, "-otxt"];
  if (WHISPER_LANG) wArgs.push("-l", WHISPER_LANG);

  log(sid, "WHISPER", "start", `model=${path.basename(WHISPER_MODEL)} lang=${WHISPER_LANG || "auto"}`);
  const w = await runBin(WHISPER_BIN, wArgs);
  if (!w.ok) {
    log(sid, "WHISPER", "fail", w.stderr.slice(-200));
    return res.sendStatus(500);
  }
  log(sid, "WHISPER", "ok");

  let text = "";
  if (fs.existsSync(LAST_TXT)) {
    text = fs.readFileSync(LAST_TXT, "utf8").trim();
  }

  if (!text) {
    log(sid, "TEXT", "empty");
    return res.json({ ok: true, text: "" });
  }

  log(sid, "TEXT", "recognized", text.slice(0, 200));

  // voice commands routing
  const action = handleVoicePhrase({ sid, text });

  if (action?.type === "key" && action.key) {
    const code = KEYS[action.key];
    if (!code) {
      log(sid, "ADB", "unknown_key", String(action.key));
      return res.json({ ok: true, text, words: action.words || [], action });
    }

    const rr = await adbShell(["input", "keyevent", String(code)]);
    log(sid, "ADB", rr.ok ? `key_ok:${action.key}` : `key_fail:${action.key}`);

    return res.json({ ok: true, text, words: action.words || [], action });
  }

  // fallback: send text as-is
  const safe = escapeForAdbText(text);
  const r = await adbShell(["input", "text", safe]);
  log(sid, "ADB", r.ok ? "text_ok" : "text_fail");

  res.json({ ok: true, text, words: action?.words || [], action });
});

// say (for Siri Shortcuts / external triggers)
app.get("/say", async (req, res) => {
  const sid = getSid(req);
  const text = String(req.query.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "missing text" });

  log(sid, "SAY", "recv", text.slice(0, 200));

  const action = handleVoicePhrase({ sid, text });

  if (action.type === "key" && action.key) {
    const code = KEYS[action.key];
    if (!code) {
      log(sid, "ADB", "unknown_key", String(action.key));
      return res.json({ ok: true, text, words: action.words || [], action });
    }

    const rr = await adbShell(["input", "keyevent", String(code)]);
    log(sid, "ADB", rr.ok ? `key_ok:${action.key}` : `key_fail:${action.key}`);

    return res.json({ ok: true, text, words: action.words || [], action });
  }

  // fallback: type text
  const safe = escapeForAdbText(text);
  const r = await adbShell(["input", "text", safe]);
  log(sid, "ADB", r.ok ? "text_ok" : "text_fail");

  return res.json({ ok: true, text, words: action.words || [], action });
});

// ===== VOICE COMMANDS (SINGLE SOURCE OF TRUTH) =====
const VOICE_COMMANDS = [
  { key: "back", aliases: ["назад", "back"], maxWords: 2 },
  { key: "home", aliases: ["домой", "home"], maxWords: 2 },
  {
    key: "volup",
    aliases: ["громче", "добавь звук", "прибавь громкость", "сделай громче", "увеличь громкость"],
    maxWords: 3,
  },
  {
    key: "voldown",
    aliases: ["тише", "убавь звук", "убавь громкость", "сделай тише", "уменьши громкость"],
    maxWords: 3,
  },
];

// Parse text -> words[] and decide action
const handleVoicePhrase = ({ sid, text }) => {
  const words = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  log(sid, "VOICE_CMD", "words", JSON.stringify(words));

  const joined = words.join(" ");
  const isShort = words.length >= 1;

  if (isShort) {
    for (const cmd of VOICE_COMMANDS) {
      if (words.length > cmd.maxWords) continue;

      for (const alias of cmd.aliases) {
        if (joined === alias) {
          log(sid, "VOICE_CMD", "match", cmd.key);
          return { type: "key", key: cmd.key, words, text };
        }
      }
    }
  }

  return { type: "text", text, words };
};

// ===============================
// NEW LAYER: ACTION RUNNER
// ===============================

// Whitelisted actions only (no arbitrary exec).
// Later we will move this into separate files.
const ACTIONS = {
  // Android actions
  "android.key": async ({ sid, params }) => {
    const key = String(params?.key || "").toLowerCase();
    const code = KEYS[key];
    if (!code) return { ok: false, error: "bad_key" };

    const rr = await adbShell(["input", "keyevent", String(code)]);
    log(sid, "ACTION", rr.ok ? `android.key ok:${key}` : `android.key fail:${key}`);
    return rr.ok ? { ok: true } : { ok: false, error: rr.error || "adb_fail" };
  },

  "android.text": async ({ sid, params }) => {
    const text = String(params?.text || "");
    if (!text) return { ok: false, error: "missing_text" };

    const safe = escapeForAdbText(text);
    const rr = await adbShell(["input", "text", safe]);
    log(sid, "ACTION", rr.ok ? "android.text ok" : "android.text fail");
    return rr.ok ? { ok: true } : { ok: false, error: rr.error || "adb_fail" };
  },

  // LG actions
  "lg.wake": async ({ sid, params }) => {
    const { lg } = getDeviceState();

    const mac = String(params?.mac || lg.mac || "");
    const ip = String(params?.ip || lg.ip || "");
    const port = Number(params?.port || lg.wolPort || 9);

    const broadcast =
      String(params?.broadcast || lg.wolBroadcast || "") || (ip ? guessBroadcastFromIp(ip) : "");

    if (!mac) return { ok: false, error: "lg_mac_missing" };

    const r = await sendWol({ mac, broadcast, port });
    log(sid, "ACTION", r.ok ? `lg.wake ok ${r.target}:${r.port}` : `lg.wake fail ${r.error}`);
    return r.ok ? { ok: true, target: r.target, port: r.port } : { ok: false, error: r.error };
  },

  "lg.volup": async ({ sid }) => {
    const { lg } = getDeviceState();
    const r = await lgVolumeUp(lg);
    log(sid, "ACTION", r.ok ? "lg.volup ok" : `lg.volup fail ${r.error}`);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },

  "lg.voldown": async ({ sid }) => {
    const { lg } = getDeviceState();
    const r = await lgVolumeDown(lg);
    log(sid, "ACTION", r.ok ? "lg.voldown ok" : `lg.voldown fail ${r.error}`);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },

  "lg.mute": async ({ sid }) => {
    const { lg } = getDeviceState();
    const r = await lgMuteToggle(lg);
    log(sid, "ACTION", r.ok ? "lg.mute ok" : `lg.mute fail ${r.error}`);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },

  "lg.poweroff": async ({ sid }) => {
    const { lg } = getDeviceState();
    const r = await lgPowerOff(lg);
    log(sid, "ACTION", r.ok ? "lg.poweroff ok" : `lg.poweroff fail ${r.error}`);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

// Minimal allowlist for external usage
const isKnownAction = (actionId) => Boolean(ACTIONS[String(actionId || "")]);

const runAction = async ({ sid, actionId, params }) => {
  const id = String(actionId || "");
  const fn = ACTIONS[id];
  if (!fn) return { ok: false, error: "unknown_action" };

  try {
    return await fn({ sid, params });
  } catch (e) {
    return { ok: false, error: e?.message || "action_fail" };
  }
};

// ===============================
// NEW ROUTES
// ===============================

// Capabilities: helps clients decide if they should send audio or text
app.get("/api/capabilities", (req, res) => {
  res.json({
    ok: true,
    server: {
      whisper: {
        enabled: true,
        modelExists: fs.existsSync(WHISPER_MODEL),
        lang: WHISPER_LANG || "auto",
      },
      lg: {
        wol: true,
        webosWsAvailable: Boolean(WS),
      },
    },
  });
});

// Devices: view current effective device config (safe subset)
app.get("/api/devices", (req, res) => {
  const sid = getSid(req);
  const { android, lg } = getDeviceState();

  log(sid, "DEVICES", "get");
  res.json({
    ok: true,
    devices: {
      android: { name: android.name, adbDevice: android.adb.device },
      lg: { name: lg.name, ip: lg.ip, mac: lg.mac, wolPort: lg.wolPort, wolBroadcast: lg.wolBroadcast },
    },
  });
});

// Execute: run a whitelisted action
// Protected by token IF REMOTE_TOKEN is set (only for this new endpoint; old endpoints remain as-is unless STRICT_AUTH=1).
app.post("/api/execute", REMOTE_TOKEN ? requireAuth : (req, _res, next) => next(), async (req, res) => {
  const sid = getSid(req);
  const actionId = String(req.body?.actionId || "").trim();
  const params = req.body?.params || {};

  if (!actionId) return res.status(400).json({ ok: false, error: "missing_actionId" });
  if (!isKnownAction(actionId)) return res.status(400).json({ ok: false, error: "unknown_action" });

  log(sid, "EXECUTE", "start", actionId);

  const out = await runAction({ sid, actionId, params });

  log(sid, "EXECUTE", out.ok ? "ok" : "fail", out.ok ? actionId : `${actionId} ${out.error || ""}`);
  res.json({ ok: out.ok, actionId, result: out });
});

// Command: accept either recognized text OR audio (fallback to whisper)
// - If client can do recognition: send { text: "..." }
// - If client can't: send multipart { audio: <file> } OR { audioBase64: "..." } (we keep it simple here)
app.post(
  "/api/command",
  REMOTE_TOKEN ? requireAuth : (req, _res, next) => next(),
  upload.single("audio"),
  async (req, res) => {
    const sid = getSid(req);

    const text = String(req.body?.text || "").trim();

    // 1) If we already have text, interpret and execute as action (optional), or just return parsed action suggestion.
    if (text) {
      log(sid, "COMMAND", "text_recv", text.slice(0, 200));

      // For now reuse existing matching (android keys vs fallback text)
      // Later we will expand into per-device intents.
      const matched = handleVoicePhrase({ sid, text });

      // Convert matched into an action suggestion
      if (matched.type === "key" && matched.key) {
        const actionId = "android.key";
        const result = await runAction({ sid, actionId, params: { key: matched.key } });
        return res.json({ ok: true, mode: "text", text, matched, executed: { actionId, result } });
      }

      // Fallback: type it
      const actionId = "android.text";
      const result = await runAction({ sid, actionId, params: { text } });
      return res.json({ ok: true, mode: "text", text, matched, executed: { actionId, result } });
    }

    // 2) No text: use audio -> whisper fallback
    if (!req.file) {
      log(sid, "COMMAND", "no_text_no_audio");
      return res.status(400).json({ ok: false, error: "missing_text_or_audio" });
    }

    log(sid, "COMMAND", "audio_recv", `bytes=${req.file.size}`);

    // overwrite last.webm (reuse stable behavior)
    replaceFile(req.file.path, LAST_WEBM);
    safeUnlink(req.file.path);

    // ffmpeg -> wav
    const ff = await runBin("ffmpeg", ["-y", "-i", LAST_WEBM, "-ar", "16000", "-ac", "1", LAST_WAV]);
    if (!ff.ok) {
      log(sid, "COMMAND", "ffmpeg_fail", ff.stderr.slice(-200));
      return res.status(500).json({ ok: false, error: "ffmpeg_fail" });
    }

    safeUnlink(LAST_TXT);

    if (!fs.existsSync(WHISPER_MODEL)) {
      log(sid, "COMMAND", "whisper_model_missing", WHISPER_MODEL);
      return res.status(500).json({ ok: false, error: "whisper_model_missing" });
    }

    const wArgs = ["-m", WHISPER_MODEL, LAST_WAV, "-otxt"];
    if (WHISPER_LANG) wArgs.push("-l", WHISPER_LANG);

    const w = await runBin(WHISPER_BIN, wArgs);
    if (!w.ok) {
      log(sid, "COMMAND", "whisper_fail", w.stderr.slice(-200));
      return res.status(500).json({ ok: false, error: "whisper_fail" });
    }

    let recognized = "";
    if (fs.existsSync(LAST_TXT)) recognized = fs.readFileSync(LAST_TXT, "utf8").trim();

    log(sid, "COMMAND", "recognized", recognized.slice(0, 200) || "(empty)");

    // Reuse the same interpretation logic
    const matched = handleVoicePhrase({ sid, text: recognized });

    if (!recognized) return res.json({ ok: true, mode: "audio", text: "", matched, executed: null });

    if (matched.type === "key" && matched.key) {
      const actionId = "android.key";
      const result = await runAction({ sid, actionId, params: { key: matched.key } });
      return res.json({
        ok: true,
        mode: "audio",
        text: recognized,
        matched,
        executed: { actionId, result },
      });
    }

    const actionId = "android.text";
    const result = await runAction({ sid, actionId, params: { text: recognized } });
    return res.json({
      ok: true,
      mode: "audio",
      text: recognized,
      matched,
      executed: { actionId, result },
    });
  },
);

// ===============================
// SERVER START (HTTPS if possible)
// ===============================

const hasTls = fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH);

if (hasTls) {
  const httpsOptions = {
    key: fs.readFileSync(TLS_KEY_PATH),
    cert: fs.readFileSync(TLS_CERT_PATH),
  };

  https.createServer(httpsOptions, app).listen(PORT, "0.0.0.0", () => {
    console.log(`Remote2 running on https://0.0.0.0:${PORT}`);
  });
} else {
  // Safe fallback for dev (keeps old project alive even if cert files are not present here)
  http.createServer(app).listen(PORT, "0.0.0.0", () => {
    console.log(`Remote2 running on http://0.0.0.0:${PORT} (TLS cert not found)`);
  });
}
