const dot = document.getElementById("dot");
const statusEl = document.getElementById("status");
const input = document.getElementById("t");

const k = (name) => fetch("/key/" + name).catch(() => {});
window.k = k;

const setOk = (ok) => {
  dot.className = "dot" + (ok ? " ok" : "");
  statusEl.textContent = ok ? "adb ON" : "adb OFF";
};

const ping = async () => {
  try {
    const r = await fetch("/api/ping");
    const j = await r.json();
    setOk(!!j.ok);
  } catch {
    setOk(false);
  }
};

const sendText = async () => {
  const v = input.value.trim();
  if (!v) return;
  input.value = "";
  try {
    await fetch("/text?t=" + encodeURIComponent(v));
  } catch {}
};
window.sendText = sendText;

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendText();
});

ping();
setInterval(ping, 2500);



// ===== VOICE: hold-to-record -> upload file to server (no whisper) =====
const micBtn = document.getElementById("micBtn");
const SID = Math.random().toString(16).slice(2, 10);

const serverLog = (msg, extra = null) => {
  fetch("/api/log?sid=" + SID, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg, extra }),
  }).catch(() => {});
};

let mediaRecorder = null;
let chunks = [];
let streamRef = null;
let isRecording = false;

const pickMime = () => {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
  return "";
};

const startRec = async () => {
  if (isRecording) return;
  isRecording = true;
  micBtn?.classList.add("recording");

  chunks = [];

  serverLog("REC_START_REQUEST");

  try {
    streamRef = await navigator.mediaDevices.getUserMedia({ audio: true });

    const mimeType = pickMime();
    serverLog("REC_GOT_STREAM", { mimeType: mimeType || "(default)" });

    mediaRecorder = new MediaRecorder(streamRef, mimeType ? { mimeType } : undefined);

    mediaRecorder.onstart = () => serverLog("REC_STARTED");

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      serverLog("REC_STOPPED", { chunks: chunks.length });

      try {
        const blobType = mediaRecorder?.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type: blobType });

        serverLog("UPLOAD_START", { bytes: blob.size, type: blob.type });

        const fd = new FormData();
        fd.append("audio", blob, "voice.webm");

        const r = await fetch("/voice-save?sid=" + SID, { method: "POST", body: fd });
        const j = await r.json().catch(() => null);

        serverLog("UPLOAD_DONE", j || { status: r.status });
      } catch (e) {
        serverLog("UPLOAD_FAIL", { name: e?.name, message: e?.message });
      } finally {
        try {
          streamRef?.getTracks()?.forEach((t) => t.stop());
        } catch {}
        mediaRecorder = null;
        streamRef = null;
        chunks = [];
        isRecording = false;
      }
    };

    mediaRecorder.start();
  } catch (e) {
    serverLog("REC_FAIL", { name: e?.name, message: e?.message });
    try {
      streamRef?.getTracks()?.forEach((t) => t.stop());
    } catch {}
    mediaRecorder = null;
    streamRef = null;
    chunks = [];
    isRecording = false;
  }
};

const stopRec = () => {
  if (!isRecording) return;
  micBtn?.classList.remove("recording");

  serverLog("REC_STOP_REQUEST");

  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch (e) {
    serverLog("REC_STOP_FAIL", { name: e?.name, message: e?.message });
    isRecording = false;
  }
};

if (micBtn) {
  micBtn.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      serverLog("BTN_DOWN", { type: "touchstart" });
      startRec();
    },
    { passive: false },
  );

  micBtn.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      serverLog("BTN_UP", { type: "touchend" });
      stopRec();
    },
    { passive: false },
  );

  micBtn.addEventListener(
    "touchcancel",
    (e) => {
      e.preventDefault();
      serverLog("BTN_UP", { type: "touchcancel" });
      stopRec();
    },
    { passive: false },
  );

  micBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    serverLog("BTN_DOWN", { type: "mousedown" });
    startRec();
  });

  window.addEventListener("mouseup", () => {
    serverLog("BTN_UP", { type: "mouseup" });
    stopRec();
  });
} else {
  serverLog("MICBTN_NOT_FOUND");
}
