/**
 * TTS — Cartesia Sonic-2 WebSocket Streaming (matches October AI production)
 * Pipeline version: 2.0
 *
 * Changes from v1:
 *  - WebSocket streaming instead of HTTP batch
 *  - sonic-2 model instead of sonic-flash
 *  - Cartesia version 2025-04-16
 *  - AsyncIterable text input for concurrent LLM+TTS
 *  - Returns cancel function for interrupt support
 *  - Context management with continue flag
 *  - 15s timeout with auto-reset on messages
 */

var WebSocket = require('ws');
var crypto = require('crypto');

var CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091';
var CARTESIA_MODEL = 'sonic-2';
var CARTESIA_VERSION = '2025-04-16';
var TTS_TIMEOUT_MS = 15000;

var OUTPUT_FORMAT = {
  container: 'raw',
  encoding: 'pcm_s16le',
  sample_rate: 24000
};

/**
 * Stream text to Cartesia and receive PCM16 audio chunks.
 *
 * @param {AsyncIterable<string>} textStream - Async iterable of text chunks from LLM
 * @param {(buffer: Buffer) => void} onAudioChunk - Called for each PCM16 audio chunk
 * @param {() => void} onDone - Called when all audio has been received
 * @param {(err: string) => void} onError - Called on error
 * @returns {() => void} cancel - Function to cancel/close the TTS stream
 */
function streamTTS(textStream, onAudioChunk, onDone, onError) {
  var apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    console.error('[TTS] CARTESIA_API_KEY is not set');
    onError('TTS_NO_API_KEY');
    return function () {};
  }

  var cancelled = false;
  var ws = null;
  var timeoutTimer = null;
  var errorEmitted = false;
  var contextId = crypto.randomUUID();

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

  function buildMsg(transcript, cont) {
    return {
      model_id: CARTESIA_MODEL,
      transcript: transcript,
      voice: { mode: 'id', id: CARTESIA_VOICE_ID },
      language: 'en',
      context_id: contextId,
      output_format: OUTPUT_FORMAT,
      continue: cont
    };
  }

  var url = 'wss://api.cartesia.ai/tts/websocket?cartesia_version=' + CARTESIA_VERSION + '&api_key=' + apiKey;

  console.log('[TTS] Connecting: voice=' + CARTESIA_VOICE_ID + ' model=' + CARTESIA_MODEL + ' format=pcm_s16le_24000');

  ws = new WebSocket(url);

  // Global timeout
  timeoutTimer = setTimeout(function () {
    if (!cancelled) {
      console.error('[TTS] Timeout after ' + TTS_TIMEOUT_MS + 'ms');
      emitError('TTS_TIMEOUT');
    }
  }, TTS_TIMEOUT_MS);

  ws.on('open', async function () {
    console.log('[TTS] Cartesia WebSocket connected');

    var chunkCount = 0;
    try {
      for await (var chunk of textStream) {
        if (cancelled || !ws || ws.readyState !== WebSocket.OPEN) break;
        if (chunk) {
          var msg = buildMsg(chunk, true);
          if (chunkCount === 0) {
            console.log('[TTS] First chunk: ' + JSON.stringify(msg).substring(0, 350));
          }
          chunkCount++;
          ws.send(JSON.stringify(msg));
        }
      }

      // Close context: empty transcript with continue: false
      if (!cancelled && ws && ws.readyState === WebSocket.OPEN) {
        if (chunkCount === 0) {
          console.warn('[TTS] No text chunks sent — skipping');
          cleanup();
          onDone();
          return;
        }
        console.log('[TTS] Closing context after ' + chunkCount + ' chunks');
        ws.send(JSON.stringify(buildMsg('', false)));
      }
    } catch (err) {
      if (!cancelled) {
        console.error('[TTS] Text stream error:', err.message);
        emitError('TTS_STREAM_ERROR');
      }
    }
  });

  ws.on('message', function (data) {
    if (cancelled) return;

    // Reset timeout on each message
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(function () {
      if (!cancelled) {
        console.error('[TTS] Timeout (no messages) after ' + TTS_TIMEOUT_MS + 'ms');
        emitError('TTS_TIMEOUT');
      }
    }, TTS_TIMEOUT_MS);

    try {
      var msg = JSON.parse(data.toString());

      if (msg.type === 'error') {
        console.error('[TTS] Cartesia error:', JSON.stringify(msg));
        emitError('TTS_API_ERROR:' + (msg.error || msg.message || 'unknown'));
        return;
      }

      // Audio chunk — base64-encoded PCM s16le
      if (msg.type === 'chunk' && msg.data) {
        var audioBuffer = Buffer.from(msg.data, 'base64');
        onAudioChunk(audioBuffer);
      }

      // Done — context is fully complete
      if (msg.type === 'done') {
        cancelled = true;
        cleanup();
        onDone();
      }
    } catch (e) {
      console.warn('[TTS] Non-JSON message:', data.toString().substring(0, 200));
    }
  });

  ws.on('error', function (err) {
    console.error('[TTS] WebSocket error:', err.message);
  });

  ws.on('close', function (code, reason) {
    var reasonStr = reason ? reason.toString() : '';
    console.log('[TTS] WebSocket closed: code=' + code + ' reason="' + reasonStr + '"');

    if (!cancelled && !errorEmitted) {
      if (code === 1000) {
        cleanup();
        onDone();
      } else {
        emitError(('TTS_WS_CLOSED:' + code + ' ' + reasonStr).trim());
      }
    }
  });

  // Return cancel function
  return cleanup;
}

module.exports = { streamTTS };
