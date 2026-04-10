/**
 * voice/voiceServer.js — WebSocket server for voice sessions
 *
 * Adapted from production voice/index.js. Behaviour is 1:1 with production
 * except that session config is received INLINE via session_init from the
 * sandbox client, rather than fetched from a tenants database row.
 *
 * Everything else — greeting, silence timer, 20-minute farewell, processTurn,
 * interrupt handling, idle timeout — matches production exactly.
 */

const { WebSocketServer } = require("ws");
const { createSession } = require("./session");
const { processTurn, generateGreeting } = require("./pipeline");
const { streamGPT } = require("./llm");
const { streamTTS } = require("../services/tts");

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSION_MS = 20 * 60 * 1000; // 20 minutes hard limit

const FAREWELL_TEXTS = {
  en: "We've reached the end of our session time. Feel free to start a new conversation anytime.",
  da: "Vi er nået til slutningen af vores sessionstid. Du er velkommen til at starte en ny samtale når som helst.",
  de: "Wir haben das Ende unserer Sitzungszeit erreicht. Sie können jederzeit ein neues Gespräch starten.",
  sv: "Vi har nått slutet av vår sessionstid. Välkommen att starta en ny konversation när som helst.",
  no: "Vi har nådd slutten av sesjonstiden vår. Du er velkommen til å starte en ny samtale når som helst.",
  fr: "Nous avons atteint la fin de notre temps de session. N'hésitez pas à démarrer une nouvelle conversation.",
  es: "Hemos llegado al final de nuestro tiempo de sesión. No dudes en iniciar una nueva conversación.",
  it: "Abbiamo raggiunto la fine del nostro tempo di sessione. Sentiti libero di iniziare una nuova conversazione.",
  nl: "We hebben het einde van onze sessietijd bereikt. U kunt op elk moment een nieuw gesprek starten.",
  pt: "Chegamos ao final do nosso tempo de sessão. Fique à vontade para iniciar uma nova conversa."
};

/**
 * Create async iterable for TTS text streaming.
 */
function createAsyncIterable(queue, isDone) {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0 && !isDone()) {
            await new Promise(r => setTimeout(r, 10));
          }
          if (queue.length > 0) return { value: queue.shift(), done: false };
          return { value: undefined, done: true };
        }
      };
    }
  };
}

/**
 * Create a voice WebSocketServer (noServer mode) with the full production
 * session handling. The caller is responsible for routing HTTP upgrade
 * events to it via wss.handleUpgrade(), which lets the caller perform
 * auth (e.g. ADMIN_SECRET check) before accepting the socket.
 */
function createVoiceWSS() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (clientWs, req) => {
    console.log("[Voice] Client connected");

    let session = null;
    let idleTimer = null;
    let silenceTimer = null;
    let silenceTriggered = false;
    let maxSessionTimer = null;

    function startSilenceTimer() {
      clearSilenceTimer();
      silenceTriggered = false;
      silenceTimer = setTimeout(async () => {
        if (!session || silenceTriggered) return;
        if (session.silenceFollowUpCount >= 1) {
          console.log("[Voice] 20s silence — already used silence follow-up, skipping");
          return;
        }
        if (session.isProcessing || session.ttsActive || session.cancelTTS) {
          console.log("[Voice] 20s silence — busy, retrying in 5s");
          silenceTimer = setTimeout(() => startSilenceTimer(), 5000);
          return;
        }
        const lastAssistantMsg = session.conversationHistory
          .filter(h => h.role === "assistant" && !h.content.startsWith("["))
          .slice(-1)[0];
        if (lastAssistantMsg && lastAssistantMsg.content.trim().endsWith("?")) {
          console.log("[Voice] 20s silence — last response was a question, skipping follow-up");
          return;
        }
        silenceTriggered = true;
        session.silenceFollowUpCount++;
        console.log("[Voice] 20s silence — triggering gentle follow-up (count=" + session.silenceFollowUpCount + ")");
        session.isProcessing = true;

        try {
          let fullText = "";
          let gptDone = false;
          let ttsStarted = false;
          const t0 = Date.now();

          let waitResolve = null;
          const queue = [];
          const textStream = {
            push(c) { queue.push(c); if (waitResolve) { waitResolve(); waitResolve = null; } },
            finish() { if (waitResolve) { waitResolve(); waitResolve = null; } },
            [Symbol.asyncIterator]() {
              return { async next() {
                while (queue.length === 0 && !gptDone) await new Promise(r => { waitResolve = r; });
                if (queue.length > 0) return { value: queue.shift(), done: false };
                return { value: undefined, done: true };
              }};
            }
          };

          send({ type: "status", value: "speaking" });
          let silenceTtsStart = 0;

          await streamGPT(
            session,
            "[SILENCE: 20 seconds have passed since you last spoke. The guest has not said anything. Break the silence naturally — offer a gentle next step or ask about their interests. Keep it short and warm.]",
            (chunk) => {
              fullText += chunk;
              if (!chunk.trim()) return;
              textStream.push(chunk);
              if (!ttsStarted && fullText.trim().split(/\s+/).length >= 4) {
                ttsStarted = true;
                if (session.cancelTTS) { session.cancelTTS(); }
                console.log("[Voice] Silence TTS started (stream threshold)");
                session.ttsActive = true;
                silenceTtsStart = Date.now();
                const cancel = streamTTS(
                  textStream,
                  (pcm) => { try { if (clientWs.readyState === 1) clientWs.send(pcm); } catch (e) {} },
                  () => { session.ttsSeconds = (session.ttsSeconds || 0) + (Date.now() - silenceTtsStart) / 1000; session.ttsActive = false; session.isProcessing = false; session.cancelTTS = null; session.ttsEndedAt = Date.now(); send({ type: "status", value: "idle" }); session.onTTSDone?.(); },
                  (err) => { console.error("[Voice] Silence TTS error:", err); session.ttsSeconds = (session.ttsSeconds || 0) + (Date.now() - silenceTtsStart) / 1000; session.ttsActive = false; session.isProcessing = false; session.cancelTTS = null; session.ttsEndedAt = Date.now(); send({ type: "status", value: "idle" }); }
                );
                session.cancelTTS = cancel;
              }
            },
            () => {},
            () => {
              gptDone = true;
              textStream.finish();
              if (!ttsStarted && fullText.trim()) {
                ttsStarted = true;
                if (session.cancelTTS) { session.cancelTTS(); }
                console.log("[Voice] Silence TTS started (short text)");
                session.ttsActive = true;
                silenceTtsStart = Date.now();
                const cancel = streamTTS(
                  textStream,
                  (pcm) => { try { if (clientWs.readyState === 1) clientWs.send(pcm); } catch (e) {} },
                  () => { session.ttsSeconds = (session.ttsSeconds || 0) + (Date.now() - silenceTtsStart) / 1000; session.ttsActive = false; session.isProcessing = false; session.cancelTTS = null; session.ttsEndedAt = Date.now(); send({ type: "status", value: "idle" }); session.onTTSDone?.(); },
                  (err) => { console.error("[Voice] Silence TTS error:", err); session.ttsSeconds = (session.ttsSeconds || 0) + (Date.now() - silenceTtsStart) / 1000; session.ttsActive = false; session.isProcessing = false; session.cancelTTS = null; session.ttsEndedAt = Date.now(); send({ type: "status", value: "idle" }); }
                );
                session.cancelTTS = cancel;
              }
              if (!ttsStarted) {
                session.isProcessing = false;
                send({ type: "status", value: "idle" });
              }
              if (fullText.trim()) {
                send({ type: "transcript", role: "assistant", text: fullText });
              }
            },
            { maxTokens: 80 }
          );
        } catch (err) {
          console.error("[Voice] Silence response error:", err.message);
          session.isProcessing = false;
          send({ type: "status", value: "idle" });
        }
      }, 20000);
    }

    function clearSilenceTimer() {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    }

    async function speakFarewellAndClose() {
      if (!session) { try { clientWs.close(1000, "Max session time"); } catch (e) {} return; }
      console.log("[Voice] Max session time reached (20min) — speaking farewell");

      if (session.cancelTTS) { session.cancelTTS(); session.cancelTTS = null; }
      session.ttsActive = false;
      session.isProcessing = false;
      clearSilenceTimer();

      const farewell = FAREWELL_TEXTS[session.language] || FAREWELL_TEXTS.en;
      const forceCloseTimer = setTimeout(() => {
        try { clientWs.close(1000, "Max session time"); } catch (e) {}
      }, 15000);

      try {
        const textStream = createAsyncIterable([farewell], () => true);

        send({ type: "status", value: "speaking" });
        send({ type: "transcript", role: "assistant", text: farewell });

        const ttsStart = Date.now();
        streamTTS(
          textStream,
          (pcm) => { try { if (clientWs.readyState === 1) clientWs.send(pcm); } catch (e) {} },
          () => {
            session.ttsSeconds = (session.ttsSeconds || 0) + (Date.now() - ttsStart) / 1000;
            clearTimeout(forceCloseTimer);
            send({ type: "session_expired" });
            try { clientWs.close(1000, "Max session time"); } catch (e) {}
          },
          () => {
            session.ttsSeconds = (session.ttsSeconds || 0) + (Date.now() - ttsStart) / 1000;
            clearTimeout(forceCloseTimer);
            send({ type: "session_expired" });
            try { clientWs.close(1000, "Max session time"); } catch (e) {}
          }
        );
      } catch (err) {
        console.error("[Voice] Farewell TTS error:", err.message);
        clearTimeout(forceCloseTimer);
        try { clientWs.close(1000, "Max session time"); } catch (e) {}
      }
    }

    // Rate limiting
    let msgCount = 0;
    let msgResetTime = Date.now();
    const MAX_MSG_PER_SEC = 100;

    function resetIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          clientWs.send(JSON.stringify({ type: "idle_timeout" }));
          clientWs.close(1000, "Idle timeout");
        } catch (e) {}
      }, IDLE_TIMEOUT_MS);
    }
    resetIdle();

    const send = (data) => {
      try { if (clientWs.readyState === 1) clientWs.send(typeof data === "string" ? data : JSON.stringify(data)); } catch (e) {}
    };

    clientWs.on("message", async (data, isBinary) => {
      resetIdle();

      const now = Date.now();
      if (now - msgResetTime > 1000) { msgCount = 0; msgResetTime = now; }
      msgCount++;
      if (msgCount > MAX_MSG_PER_SEC) return;

      // Binary data = PCM16 audio from client VAD
      if (isBinary) {
        if (!session) return;
        if (session.isProcessing) return;
        if (session.ttsActive) return;
        session.isProcessing = true;
        processTurn(session, data, clientWs)
          .catch(err => console.error(err))
          .finally(() => {
            if (!session.ttsActive) {
              session.isProcessing = false;
            }
          });
        return;
      }

      // JSON control messages
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }

      function initSession(msg, label) {
        if (session) {
          console.log(`[Voice] Ignoring duplicate ${label} — session already active`);
          return;
        }

        // Accept both `{type, ...config}` (production style) and
        // `{type, config: {...}}` (sandbox client style)
        const cfg = msg.config || msg;
        const tenantId = msg.tenantId || cfg.tenantId || "sandbox";

        // roomMappings may arrive as an object OR as a JSON string (the
        // sandbox client reads it from a textarea). Parse defensively.
        let rawRoomMappings = cfg.roomMappings || {};
        if (typeof rawRoomMappings === "string") {
          try { rawRoomMappings = rawRoomMappings.trim() ? JSON.parse(rawRoomMappings) : {}; }
          catch (e) { console.warn("[Voice] roomMappings JSON parse failed:", e.message); rawRoomMappings = {}; }
        }
        if (!rawRoomMappings || typeof rawRoomMappings !== "object") rawRoomMappings = {};

        const places = (cfg.places && typeof cfg.places === "object") ? { ...cfg.places } : {};
        if (Object.keys(places).length === 0) {
          Object.keys(rawRoomMappings).forEach(k => {
            const entry = rawRoomMappings[k];
            places[k] = (entry && typeof entry === "object") ? (entry.label || k) : entry;
          });
        }

        session = createSession(tenantId, {
          language: cfg.language || "en",
          propertyName: cfg.propertyName || cfg.agentName || "",
          vertical: cfg.vertical || "other",
          // Prefer pre-compiled context; fall back to raw propertyData so
          // the agent always has *something* to work with in the sandbox.
          compiledContext: cfg.compiledContext || cfg.propertyData || "",
          places,
          conversionUrl: cfg.conversionUrl || "",
          roomMappings: rawRoomMappings,
          propertyDetails: cfg.propertyDetails || null
        });
        session.onTTSDone = () => startSilenceTimer();

        console.log(`[Voice] Session ${session.id.slice(0, 8)} started via ${label} (vertical=${session.vertical}, places=${Object.keys(places).length}, lang=${session.language}, ctx=${(cfg.compiledContext || cfg.propertyData || "").length}ch)`);
        send({ type: "status", value: "connected" });

        // Generate welcome greeting — blocks new turns until done
        if (!msg.skipWelcome) {
          session.isProcessing = true;
          generateGreeting(session, clientWs).finally(() => {
            session.isProcessing = false;
          });
        }

        maxSessionTimer = setTimeout(() => speakFarewellAndClose(), MAX_SESSION_MS);
      }

      switch (msg.type) {
        case "session_init": {
          initSession(msg, "session_init");
          break;
        }

        // Sandbox client historically sends "config" instead of session_init —
        // treat it identically so the sandbox and production share the same flow.
        case "config": {
          initSession(msg, "config");
          break;
        }

        case "interrupt": {
          if (session?.cancelTTS) {
            session.cancelTTS();
            session.cancelTTS = null;
          }
          send({ type: "status", value: "idle" });
          break;
        }

        case "ping": {
          send({ type: "pong" });
          if (session) session.lastActivityAt = Date.now();
          break;
        }

        case "position_update": {
          if (session && msg.placeId) {
            session.currentPlace = msg.placeId;
          }
          break;
        }
      }
    });

    clientWs.on("close", () => {
      console.log(`[Voice] Client disconnected${session ? " (turns=" + session.turnCount + " state=" + session.state + ")" : ""}`);
      if (session) {
        if (session.cancelTTS) { try { session.cancelTTS(); } catch (e) {} }
        session.ttsActive = false;
      }
      if (idleTimer) clearTimeout(idleTimer);
      if (maxSessionTimer) { clearTimeout(maxSessionTimer); maxSessionTimer = null; }
      clearSilenceTimer();
    });

    clientWs.on("error", (err) => {
      console.error("[Voice] WS error:", err.message);
    });
  });

  return wss;
}

module.exports = { createVoiceWSS };
