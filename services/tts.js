/**
 * services/tts.js — Cartesia Sonic WebSocket Streaming TTS
 *
 * Ported 1:1 from production (platform/services/tts.js).
 *
 * Streams text chunks to Cartesia and returns PCM16 audio chunks.
 * Uses WebSocket streaming API for lowest latency (~40ms TTFB).
 *
 * Protocol (from Cartesia docs):
 *   - All chunks: continue: true (keeps context open)
 *   - Final signal: empty transcript + continue: false (closes context)
 *   - Each message must include model_id, voice, output_format, language
 */

const WebSocket = require("ws");
const { randomUUID } = require("crypto");

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID || "a0e99841-438c-4a64-b679-ae501e7d6091";
const CARTESIA_MODEL = "sonic-2";
const CARTESIA_VERSION = "2025-04-16";
const TTS_TIMEOUT_MS = 15000;

const OUTPUT_FORMAT = {
  container: "raw",
  encoding: "pcm_s16le",
  sample_rate: 24000
};

/**
 * Stream text to Cartesia and receive PCM16 audio chunks.
 *
 * @param {AsyncIterable<string>} textStream - Async iterable of text chunks
 * @param {(buffer: Buffer) => void} onAudioChunk - Called for each PCM16 audio chunk
 * @param {() => void} onDone - Called when all audio has been received
 * @param {(err: string) => void} onError - Called on error
 * @returns {() => void} cancel - Function to cancel/close the TTS stream
 */
function streamTTS(textStream, onAudioChunk, onDone, onError) {
  if (!CARTESIA_API_KEY) {
    console.error("[TTS] CARTESIA_API_KEY is not set");
    onError("TTS_NO_API_KEY");
    return () => {};
  }

  let cancelled = false;
  let ws = null;
  let timeoutTimer = null;
  let errorEmitted = false;
  const contextId = randomUUID();

  function emitError(msg) {
    if (errorEmitted || cancelled) return;
    errorEmitted = true;
    cleanup();
    onError(msg);
  }

  function cleanup() {
    cancelled = true;
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    if (ws) {
      try { ws.close(); } catch (e) {}
      ws = null;
    }
  }

  // Build a full message matching the official Cartesia example format
  function buildMsg(transcript, cont) {
    return {
      model_id: CARTESIA_MODEL,
      transcript,
      voice: { mode: "id", id: CARTESIA_VOICE_ID },
      language: "en",
      context_id: contextId,
      output_format: OUTPUT_FORMAT,
      continue: cont
    };
  }

  const url = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${CARTESIA_VERSION}&api_key=${CARTESIA_API_KEY}`;

  console.log(`[TTS] Connecting: voice=${CARTESIA_VOICE_ID} model=${CARTESIA_MODEL} format=pcm_s16le_24000`);

  ws = new WebSocket(url);

  // Timeout: total TTS operation
  timeoutTimer = setTimeout(() => {
    if (!cancelled) {
      console.error("[TTS] Timeout after " + TTS_TIMEOUT_MS + "ms");
      emitError("TTS_TIMEOUT");
    }
  }, TTS_TIMEOUT_MS);

  ws.on("open", async () => {
    console.log("[TTS] Cartesia WebSocket connected");

    let chunkCount = 0;
    try {
      for await (const chunk of textStream) {
        if (cancelled || !ws || ws.readyState !== WebSocket.OPEN) break;
        if (chunk) {
          const msg = buildMsg(chunk, true);
          if (chunkCount === 0) {
            console.log(`[TTS] First chunk → ${JSON.stringify(msg).substring(0, 350)}`);
          }
          chunkCount++;
          ws.send(JSON.stringify(msg));
        }
      }

      // Close context: send empty transcript with continue: false
      // (from Cartesia docs: "If you do not know the last transcript in advance,
      //  you can send an input with an empty transcript and continue set to false.")
      if (!cancelled && ws && ws.readyState === WebSocket.OPEN) {
        if (chunkCount === 0) {
          console.warn("[TTS] No text chunks sent — skipping");
          cleanup();
          onDone();
          return;
        }
        console.log(`[TTS] Closing context after ${chunkCount} chunks`);
        ws.send(JSON.stringify(buildMsg("", false)));
      }
    } catch (err) {
      if (!cancelled) {
        console.error("[TTS] Text stream error:", err.message);
        emitError("TTS_STREAM_ERROR");
      }
    }
  });

  ws.on("message", (data) => {
    if (cancelled) return;

    // Reset timeout on each message
    if (timeoutTimer) { clearTimeout(timeoutTimer); }
    timeoutTimer = setTimeout(() => {
      if (!cancelled) {
        console.error("[TTS] Timeout (no messages) after " + TTS_TIMEOUT_MS + "ms");
        emitError("TTS_TIMEOUT");
      }
    }, TTS_TIMEOUT_MS);

    try {
      const msg = JSON.parse(data.toString());

      // Cartesia error message
      if (msg.type === "error") {
        console.error("[TTS] Cartesia error response:", JSON.stringify(msg));
        emitError("TTS_API_ERROR:" + (msg.error || msg.message || "unknown"));
        return;
      }

      // Audio chunk — base64-encoded PCM s16le
      if (msg.type === "chunk" && msg.data) {
        const audioBuffer = Buffer.from(msg.data, "base64");
        onAudioChunk(audioBuffer);
      }

      // Completion — done means context is fully complete
      if (msg.type === "done") {
        cancelled = true;
        cleanup();
        onDone();
      }
    } catch (e) {
      console.warn("[TTS] Non-JSON message from Cartesia:", data.toString().substring(0, 200));
    }
  });

  ws.on("error", (err) => {
    console.error("[TTS] WebSocket error:", err.message);
  });

  ws.on("close", (code, reason) => {
    const reasonStr = reason ? reason.toString() : "";
    console.log(`[TTS] WebSocket closed: code=${code} reason="${reasonStr}"`);

    if (!cancelled && !errorEmitted) {
      if (code === 1000) {
        cleanup();
        onDone();
      } else {
        emitError(`TTS_WS_CLOSED:${code} ${reasonStr}`.trim());
      }
    }
  });

  // Return cancel function
  return cleanup;
}

module.exports = { streamTTS };
