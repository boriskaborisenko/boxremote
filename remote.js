// remote.js
// Stable version: single rotating voice file + ffmpeg + old whisper.cpp
// NOTHING else touched (except: /api/ping, HTTPS, and explicit whisper model+lang).

const https = require("https");

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { spawn } = require("child_process");

// ===== BOOT =====
console.log("REMOTE BOOT v123000", new Date().toISOString());

const app = express();

// ===== CONFIG =====
const PORT = 4878;

const ADB = "adb";
const DEVICE = "192.168.100.84:5555";

const TMP_DIR = "tmp";
const VOICE_DIR = "voice";

const WHISPER_BIN = "whisper"; // old whisper.cpp CLI
const WHISPER_MODEL = path.join(__dirname, "models", "ggml-base.bin"); // multilingual (RU works)
const WHISPER_LANG = "ru"; // "" for auto-detect, "ru" for forced Russian

const LAST_WEBM = path.join(VOICE_DIR, "last.webm");
const LAST_WAV = path.join(VOICE_DIR, "last.wav");
const LAST_TXT = path.join(VOICE_DIR, "last.wav.txt");

let boxSleeping = false;
// ===== ANDROID KEYS =====
const KEYS = {
  power: 0, // special marker
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

const runBin = (bin, args) =>
  new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
  if (!r.ok) return { ok: false, error: r.stderr };
  return { ok: true };
};

// ===== INIT =====
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(VOICE_DIR, { recursive: true });

app.use(express.json({ limit: "256kb" }));
app.use(express.static(__dirname));

// ACCESS LOG (only important routes)
app.use((req, res, next) => {
  if (req.url.startsWith("/voice-save") || req.url.startsWith("/api/log")) {
    console.log("[HIT]", req.method, req.url);
  }
  next();
});

// ===== ROUTES =====

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
/* app.get("/key/:name", async (req, res) => {
  const code = KEYS[req.params.name];
  if (!code) return res.status(400).send("bad key");
  const r = await adbShell(["input", "keyevent", String(code)]);
  if (!r.ok) return res.status(500).send(r.error);
  res.send("ok");
}); */

app.get("/key/:name", async (req, res) => {
  const name = req.params.name;
  const code = KEYS[name];

  if (code === undefined) {
    return res.status(400).send("bad key");
  }

  // Special toggle logic for POWER
  if (code === 0) {
    const keycode = boxSleeping ? 224 : 223; // wake : sleep
    const r = await adbShell(["input", "keyevent", String(keycode)]);
    if (!r.ok) return res.status(500).send(r.error);

    boxSleeping = !boxSleeping;
    return res.send("ok");
  }

  // Default behavior
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

// ===== VOICE =====
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
  const ff = await runBin("ffmpeg", [
    "-y",
    "-i",
    LAST_WEBM,
    "-ar",
    "16000",
    "-ac",
    "1",
    LAST_WAV,
  ]);
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

  log(
    sid,
    "WHISPER",
    "start",
    `model=${path.basename(WHISPER_MODEL)} lang=${WHISPER_LANG || "auto"}`,
  );
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


// ===== START (HTTPS) =====
/* const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, "key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "boxremote.pem")),
}; */
const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, "192.168.100.85-key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "192.168.100.85.pem")),
};

https.createServer(httpsOptions, app).listen(PORT, "0.0.0.0", () => {
  console.log(`Remote running on https://192.168.100.85:${PORT}`);
});

/////////////////////////////////////////////////

// say (for Siri Shortcuts / external triggers)
/* app.get("/say", async (req, res) => {
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
}); */

app.get("/say", async (req, res) => {
  const sid = getSid(req);
  const text = String(req.query.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "missing text" });

  log(sid, "SAY", "recv", text.slice(0, 200));

  const action = handleVoicePhrase({ sid, text });

  if (action.type === "key" && action.key) {
    const code = KEYS[action.key];

    // NOTE: code can be 0 (special marker), so only undefined means "unknown"
    if (code === undefined) {
      log(sid, "ADB", "unknown_key", String(action.key));
      return res.json({ ok: true, text, words: action.words || [], action });
    }

    // Special toggle logic for POWER (code === 0)
    if (code === 0) {
      const keycode = boxSleeping ? 224 : 223; // wake : sleep
      const rr = await adbShell(["input", "keyevent", String(keycode)]);
      log(
        sid,
        "ADB",
        rr.ok ? `power_${boxSleeping ? "wake" : "sleep"}` : "power_fail",
      );

      if (rr.ok) boxSleeping = !boxSleeping;

      return res.json({ ok: true, text, words: action.words || [], action });
    }

    // Default key handling
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




// Voice commands config (single source of truth)
const VOICE_COMMANDS = [
  {
    key: "power",
    aliases: ["wake","sleep"],
    maxWords: 2,
  },
  {
    key: "back",
    aliases: ["назад", "back"],
    maxWords: 2,
  },
  {
    key: "home",
    aliases: ["домой", "home"],
    maxWords: 2,
  },
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
    .replace(/[^\p{L}\p{N}\s]+/gu, " ") // keep RU/EN letters and numbers
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
