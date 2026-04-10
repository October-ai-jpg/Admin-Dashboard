/**
 * voice/pipeline.js — Orchestrates: STT → LLM → TTS for one turn
 *
 * Ported 1:1 from production (platform/voice/pipeline.js).
 */

const { transcribeAudio, filterNoise } = require("./stt");
const { streamGPT } = require("./llm");
const { streamTTS } = require("../services/tts");
const { transitionState } = require("./session");
const { wrapStreamForTTS } = require("./ttsNormalize");
const { logMessage, logConversion } = require("../routes/analytics");
const { query } = require("../db/index");

/**
 * Event-driven text stream bridge between GPT and TTS.
 */
function createTextStream(queue, isDone) {
  let waitResolve = null;
  const stream = {
    push(chunk) {
      queue.push(chunk);
      if (waitResolve) { waitResolve(); waitResolve = null; }
    },
    finish() {
      if (waitResolve) { waitResolve(); waitResolve = null; }
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0 && !isDone()) {
            await new Promise(r => { waitResolve = r; });
          }
          if (queue.length > 0) return { value: queue.shift(), done: false };
          return { value: undefined, done: true };
        }
      };
    }
  };
  return stream;
}

/**
 * Handle a tool call from GPT.
 */
function handleToolCall(toolName, args, session, clientWs) {
  const send = (data) => {
    try { if (clientWs.readyState === 1) clientWs.send(JSON.stringify(data)); } catch (e) {}
  };

  switch (toolName) {
    case "navigate_to_room": {
      const roomId = args.room_id;
      if (!roomId || !session.places[roomId]) break;
      const label = typeof session.places[roomId] === "object"
        ? session.places[roomId].label : session.places[roomId];
      if (!session.recommendedRooms.includes(roomId)) session.recommendedRooms.push(roomId);
      session.lastRecommendedRoom = roomId;
      session.navigatedRooms.push(roomId);
      session.toolsUsed.navigate_to_room = (session.toolsUsed.navigate_to_room || 0) + 1;
      send({ type: "navigate", roomId, label });
      console.log(`[Pipeline] navigate_to_room: ${roomId} (${label})`);
      if (session.conversationId) {
        logConversion(session.tenantId, session.conversationId, "navigation", { roomId, reason: args.reason }).catch(() => {});
        // Track rooms shown
        query(
          `UPDATE conversations SET rooms_shown = COALESCE(rooms_shown, '[]'::jsonb) || $1::jsonb WHERE id = $2`,
          [JSON.stringify([roomId]), session.conversationId]
        ).catch(() => {});
      }
      break;
    }
    case "trigger_conversion": {
      session.toolsUsed.trigger_conversion = (session.toolsUsed.trigger_conversion || 0) + 1;
      transitionState(session, "closing");
      // Retail: use productUrl from last recommended room if available
      var convUrl = session.conversionUrl;
      if ((session.vertical === "retail" || session.vertical === "showroom") && session.lastRecommendedRoom) {
        var roomData = session.roomMappings[session.lastRecommendedRoom];
        if (roomData && roomData.productUrl) {
          convUrl = roomData.productUrl;
          console.log("[Pipeline] Retail: using productUrl from room", session.lastRecommendedRoom);
        }
      }
      send({ type: "conversion", url: convUrl, message: args.message || "" });
      console.log("[Pipeline] trigger_conversion:", args.message);
      if (session.conversationId) {
        logConversion(session.tenantId, session.conversationId, "booking_click", { message: args.message, source: "gpt_function" }).catch(() => {});
        // Track rooms clicked (the last recommended room)
        var clickedRoom = session.lastRecommendedRoom || "unknown";
        query(
          `UPDATE conversations SET rooms_clicked = COALESCE(rooms_clicked, '[]'::jsonb) || $1::jsonb WHERE id = $2`,
          [JSON.stringify([clickedRoom]), session.conversationId]
        ).catch(() => {});
      }
      break;
    }
    case "update_user_profile": {
      const { field, value } = args;
      if (field && session.userProfile.hasOwnProperty(field)) {
        if (field === "preferences" && Array.isArray(session.userProfile.preferences)) {
          session.userProfile.preferences.push(value);
        } else {
          session.userProfile[field] = value;
        }
        console.log(`[Pipeline] update_user_profile: ${field} = ${value}`);
        // Persist contact info on conversation row
        if (session.conversationId && ["name", "email", "phone"].includes(field) && value) {
          var col = field === "name" ? "guest_name" : field === "email" ? "guest_email" : "guest_phone";
          query(`UPDATE conversations SET ${col} = $1 WHERE id = $2`, [value, session.conversationId]).catch(() => {});
        }
      }
      break;
    }
    case "update_conversation_state": {
      if (args.new_state) {
        const ok = transitionState(session, args.new_state);
        console.log(`[Pipeline] state → ${session.state} (${ok ? "ok" : "rejected"}) — ${args.reason}`);
      }
      break;
    }
    case "set_view_mode": {
      const mode = args.mode;
      if (!["inside", "floorplan", "dollhouse"].includes(mode)) break;
      session.toolsUsed.set_view_mode = (session.toolsUsed.set_view_mode || 0) + 1;
      send({ type: "set_view_mode", mode });
      console.log(`[Pipeline] set_view_mode: ${mode} — ${args.reason || ""}`);
      break;
    }
    default:
      console.warn("[Pipeline] Unknown tool:", toolName);
  }
}

let ttsStreamCounter = 0;

/**
 * Start TTS streaming. Returns cancel function.
 * Cancels any existing TTS before starting a new one to prevent double streams.
 */
function startTTS(textStream, session, clientWs, t0, tSttDone, tGptFirst, onFinish, trigger = "unknown") {
  const streamId = ++ttsStreamCounter;
  const ttsStartedAt = Date.now();

  // Guard: cancel existing TTS if still active
  if (session.cancelTTS) {
    console.warn(`[TTS-Guard] Stream #${streamId} (${trigger}): Cancelling existing TTS before starting new stream`);
    session.cancelTTS();
    session.cancelTTS = null;
  }

  session.ttsActive = true;
  console.log(`[TTS-Open] Stream #${streamId} trigger="${trigger}" t=${Date.now() - t0}ms`);

  let tTtsFirst = 0;
  const send = (data) => {
    try { if (clientWs.readyState === 1) clientWs.send(JSON.stringify(data)); } catch (e) {}
  };
  send({ type: "status", value: "speaking" });

  const cancel = streamTTS(
    textStream,
    (pcm16Chunk) => {
      if (!tTtsFirst) {
        tTtsFirst = Date.now();
        console.log(`[Latency] STT=${tSttDone - t0}ms GPT_first=${tGptFirst - t0}ms TTS_first=${tTtsFirst - t0}ms`);
      }
      try { if (clientWs.readyState === 1) clientWs.send(pcm16Chunk); } catch (e) {}
    },
    () => {
      console.log(`[TTS-Close] Stream #${streamId} (${trigger}) done — ${Date.now() - t0}ms`);
      session.ttsSeconds = (session.ttsSeconds || 0) + (Date.now() - ttsStartedAt) / 1000;
      session.ttsActive = false;
      session.isProcessing = false; // Release turn lock only when audio is truly done
      session.cancelTTS = null;
      session.ttsEndedAt = Date.now();
      send({ type: "status", value: "idle" });
      console.log(`[Latency] TOTAL=${Date.now() - t0}ms`);
      if (onFinish) onFinish();
      session.onTTSDone?.();
    },
    (err) => {
      console.error(`[TTS-Error] Stream #${streamId} (${trigger}):`, err);
      session.ttsSeconds = (session.ttsSeconds || 0) + (Date.now() - ttsStartedAt) / 1000;
      session.ttsActive = false;
      session.isProcessing = false; // Release turn lock on error too
      session.cancelTTS = null;
      session.ttsEndedAt = Date.now();
      send({ type: "status", value: "idle" });
      if (onFinish) onFinish();
      session.onTTSDone?.();
    }
  );
  session.cancelTTS = cancel;
  return cancel;
}

/**
 * Run one GPT call → collect text + tool calls → start TTS if text.
 * Returns { text, hadToolCalls }.
 */
async function runGPTAndTTS(session, userMessage, clientWs, t0, tSttDone, gptOptions = {}) {
  let fullText = "";
  let tGptFirst = 0;
  let gptDone = false;
  let ttsStarted = false;
  let hadToolCalls = false;
  let repeating = false;
  const textStream = wrapStreamForTTS(createTextStream([], () => gptDone), session.language);

  // Welcome-prefix stripper — runGPTAndTTS is always mid-conversation
  // (the greeting goes through generateGreeting separately), so any
  // "Welcome back", "Hi again" etc. at the start is an unwanted re-greeting.
  // Fast-path: if the first non-whitespace char is not W/H/G, commit immediately (no latency).
  let welcomeBuffer = "";
  let welcomeDecided = false;
  const WELCOME_PREFIX_RE = /^(welcome(\s*back)?[\s\-—,:.!]*|hi\s+again[\s\-—,:.!]*|hello\s+again[\s\-—,:.!]*|good\s+to\s+see\s+you(\s+again)?[\s\-—,:.!]*)/i;

  const send = (data) => {
    try { if (clientWs.readyState === 1) clientWs.send(JSON.stringify(data)); } catch (e) {}
  };

  await streamGPT(
    session,
    userMessage,

    // onTextChunk
    (chunk) => {
      if (!tGptFirst) tGptFirst = Date.now();

      // Strip any re-greeting prefix before it reaches TTS or fullText
      if (!welcomeDecided) {
        welcomeBuffer += chunk;
        const trimmed = welcomeBuffer.trimStart();
        if (trimmed.length === 0) return; // all whitespace so far
        const firstChar = trimmed[0].toLowerCase();
        if (firstChar !== 'w' && firstChar !== 'h' && firstChar !== 'g') {
          // Fast path — cannot be a welcome, commit and continue
          welcomeDecided = true;
          chunk = welcomeBuffer;
          welcomeBuffer = "";
        } else if (trimmed.length < 25) {
          return; // keep buffering until we can decide
        } else {
          welcomeDecided = true;
          const match = trimmed.match(WELCOME_PREFIX_RE);
          if (match) {
            console.warn("[Pipeline] Stripped re-greeting prefix:", match[0]);
            const leadWs = welcomeBuffer.length - trimmed.length;
            chunk = welcomeBuffer.substring(leadWs + match[0].length);
          } else {
            chunk = welcomeBuffer;
          }
          welcomeBuffer = "";
          if (!chunk) return;
        }
      }

      fullText += chunk;

      // Safety-net tool leak detection (primary suppression is in llm.js buffer)
      const TOOL_LEAK_BRACKET = /\[\s*(navigate|trigger|update|functions)/;
      const TOOL_LEAK_BARE = /\b(navigate_to_room|trigger_conversion|update_user_profile|update_conversation_state)\b/;
      const TOOL_LEAK_PARTIAL = /\b(navigate_|trigger_|update_)/;
      if (!repeating && (TOOL_LEAK_BRACKET.test(fullText) || TOOL_LEAK_BARE.test(fullText) || TOOL_LEAK_PARTIAL.test(fullText))) {
        console.warn("[Pipeline] Tool call leak detected (safety-net):", fullText.substring(0, 100));
        repeating = true;
        return;
      }

      // Detect repetition — stop feeding TTS if GPT repeats itself
      if (!repeating && fullText.length > 60) {
        // 1. Same-sentence repetition: text after first "." starts the same as text before it
        const dotIdx = fullText.indexOf('.');
        if (dotIdx > 10 && dotIdx < fullText.length - 10) {
          const first = fullText.substring(0, dotIdx + 1).trim();
          const rest = fullText.substring(dotIdx + 1).trim();
          const cmp = first.substring(0, Math.min(40, first.length));
          if (rest.length >= cmp.length && rest.substring(0, cmp.length) === cmp) {
            console.warn("[Pipeline] Sentence repetition detected — stopping TTS feed");
            repeating = true;
          }
        }
        // 2. Full-response repetition: the first 40 chars appear again later in the text
        //    Catches GPT repeating entire multi-sentence answers
        if (!repeating && fullText.length > 120) {
          const prefix = fullText.substring(0, 40);
          const repeatIdx = fullText.indexOf(prefix, 40);
          if (repeatIdx > 0) {
            console.warn("[Pipeline] Full-response repetition at pos " + repeatIdx + " — stopping TTS feed");
            repeating = true;
          }
        }
      }
      if (repeating) return;

      // Skip whitespace-only chunks (newlines, spaces) — Cartesia rejects empty transcripts
      if (!chunk.trim()) return;

      textStream.push(chunk);

      // Skip TTS if another stream is already active (e.g. from a previous runGPTAndTTS call in the same turn)
      if (!ttsStarted && !session.ttsActive && fullText.trim().split(/\s+/).length >= 4) {
        ttsStarted = true;
        startTTS(textStream, session, clientWs, t0, tSttDone, tGptFirst, undefined, "gpt-stream-threshold");
      }
    },

    // onToolCall
    (toolName, args) => {
      hadToolCalls = true;
      handleToolCall(toolName, args, session, clientWs);
    },

    // onDone
    () => {
      gptDone = true;

      // Flush welcome-buffer if stream ended while still buffering
      if (!welcomeDecided && welcomeBuffer) {
        welcomeDecided = true;
        const trimmed = welcomeBuffer.trimStart();
        const match = trimmed.match(WELCOME_PREFIX_RE);
        let flushChunk;
        if (match) {
          console.warn("[Pipeline] Stripped re-greeting prefix (flush):", match[0]);
          const leadWs = welcomeBuffer.length - trimmed.length;
          flushChunk = welcomeBuffer.substring(leadWs + match[0].length);
        } else {
          flushChunk = welcomeBuffer;
        }
        welcomeBuffer = "";
        if (flushChunk) {
          fullText += flushChunk;
          if (!repeating && flushChunk.trim()) textStream.push(flushChunk);
        }
      }

      textStream.finish();

      // Clean corrupted text from transcript
      if (repeating) {
        const bracketIdx = fullText.lastIndexOf('[');
        if (bracketIdx > 0) {
          fullText = fullText.substring(0, bracketIdx).trim();
          console.warn("[Pipeline] Trimmed tool leak at bracket — kept:", fullText.substring(0, 80));
        } else {
          // Trim at bare/partial tool name fragment
          const partialMatch = fullText.match(/\b(navigate_|trigger_|update_)/);
          if (partialMatch && partialMatch.index > 0) {
            fullText = fullText.substring(0, partialMatch.index).trim();
            console.warn("[Pipeline] Trimmed partial tool leak — kept:", fullText.substring(0, 80));
          } else if (partialMatch || /\b(navigate_to_room|trigger_conversion|update_user_profile|update_conversation_state)\b/.test(fullText)) {
            console.warn("[Pipeline] Clearing tool call leak from transcript");
            fullText = "";
          } else {
            // Repetition — keep text before repeat starts
            const prefix = fullText.substring(0, Math.min(40, fullText.length));
            const repeatIdx = fullText.indexOf(prefix, 40);
            if (repeatIdx > 0) {
              fullText = fullText.substring(0, repeatIdx).trim();
              console.warn("[Pipeline] Trimmed full-response repeat — kept:", fullText.substring(0, 80));
            } else {
              // Fallback: keep first sentence
              const dotIdx2 = fullText.indexOf('.');
              if (dotIdx2 > 0) fullText = fullText.substring(0, dotIdx2 + 1).trim();
            }
          }
        }
      }

      // Short text that didn't reach threshold — start TTS now
      // Skip if another TTS stream is already active from a previous call in this turn
      if (!ttsStarted && !session.ttsActive && fullText.trim()) {
        ttsStarted = true;
        startTTS(textStream, session, clientWs, t0, tSttDone, tGptFirst, undefined, "gpt-done-short");
      }

      if (fullText.trim()) {
        send({ type: "transcript", role: "assistant", text: fullText });
        if (session.conversationId) {
          logMessage(session.tenantId, session.conversationId, "assistant", fullText).catch(() => {});
        }
      }
    },
    gptOptions
  );

  return { text: fullText, hadToolCalls, ttsStarted };
}

const TTS_COOLDOWN_MS = 1500; // Post-TTS cooldown to prevent echo pickup
const UNCLEAR_AUDIO_THRESHOLD = 3; // Consecutive unclear events before showing popup

/**
 * Increment the unclear-audio counter and send popup signal if threshold hit.
 * Lightweight: no new async work, no prompt/model impact.
 */
function noteUnclearAudio(session, clientWs, reason) {
  session.unclearAudioCount = (session.unclearAudioCount || 0) + 1;
  console.log(`[Pipeline] Unclear audio (${reason}) — count=${session.unclearAudioCount}`);
  if (session.unclearAudioCount >= UNCLEAR_AUDIO_THRESHOLD && !session.unclearPopupSent) {
    session.unclearPopupSent = true;
    try {
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ type: "unclear_audio", reason }));
      }
    } catch (e) {}
  }
}

/**
 * Process a single voice turn: STT → LLM → TTS
 * If GPT returns tools but no text, makes a follow-up GPT call to get the spoken response.
 */
async function processTurn(session, pcm16Buffer, clientWs) {
  // isProcessing is now managed by the caller (index.js) for synchronous guard
  if (session.ttsEndedAt && (Date.now() - session.ttsEndedAt) < TTS_COOLDOWN_MS) {
    console.log(`[Pipeline] Skipping — cooldown (${Date.now() - session.ttsEndedAt}ms)`);
    return;
  }

  console.log(`[Pipeline] Turn #${session.turnCount + 1} started — cancelTTS=${!!session.cancelTTS}`);
  session.lastActivityAt = Date.now();

  const send = (data) => {
    try { if (clientWs.readyState === 1) clientWs.send(JSON.stringify(data)); } catch (e) {}
  };

  try {
    const t0 = Date.now();

    if (session.cancelTTS) { session.cancelTTS(); session.cancelTTS = null; }

    // Pre-check: reject short audio silently (echo fragments)
    if (pcm16Buffer.length < 24000) {
      console.log(`[Pipeline] Audio too short (${pcm16Buffer.length} bytes) — dropping`);
      // Count as "unclear" only if there was a meaningful attempt to speak
      // (not tiny echo fragments)
      if (pcm16Buffer.length >= 8000) noteUnclearAudio(session, clientWs, "short_audio");
      return;
    }

    // STT — validate BEFORE sending "thinking" to client
    // Sending "thinking" too early causes the client to clear its playback buffer,
    // cutting off the last words of the previous response for noise/echo turns.
    let transcript;
    let sttConfidence = 1.0;
    try {
      const sttResult = await transcribeAudio(pcm16Buffer, session.language);
      transcript = sttResult.text;
      sttConfidence = sttResult.confidence ?? 1.0;
    } catch (sttErr) {
      console.log(`[Pipeline] STT error: ${sttErr.message}`);
      noteUnclearAudio(session, clientWs, "stt_error");
      return;
    }
    const tSttDone = Date.now();
    console.log(`[Pipeline] STT: "${transcript}" (${tSttDone - t0}ms, conf=${sttConfidence.toFixed(2)})`);

    const { filtered, reason, text: cleanTranscript } = filterNoise(transcript, session.lastTranscription, sttConfidence);
    if (filtered) {
      console.log(`[Pipeline] Filtered (${reason}): "${transcript}" conf=${sttConfidence.toFixed(2)}`);
      // User-voice-related filter reasons count as "unclear audio";
      // ambient/TV/copyright/duplicate reasons don't
      const USER_UNCLEAR_REASONS = new Set(["empty", "low_confidence", "too_short", "hallucination"]);
      if (USER_UNCLEAR_REASONS.has(reason)) {
        noteUnclearAudio(session, clientWs, reason);
      }
      return;
    }

    // Echo detection: check if transcription matches the last assistant response
    // (mic picks up TTS output and Deepgram transcribes it)
    const lastAssistantMsg = session.conversationHistory
      .filter(h => h.role === "assistant" && !h.content.startsWith("["))
      .slice(-1)[0];
    if (lastAssistantMsg) {
      const assistantWords = lastAssistantMsg.content.toLowerCase().split(/\s+/).slice(0, 15).join(" ");
      const userWords = cleanTranscript.toLowerCase().split(/\s+/).slice(0, 15).join(" ");
      // If ≥60% of the first 15 words overlap, it's likely echo
      const aSet = new Set(assistantWords.split(" "));
      const uWords = userWords.split(" ");
      const overlap = uWords.filter(w => aSet.has(w)).length;
      if (uWords.length >= 3 && overlap / uWords.length > 0.6) {
        console.log(`[Pipeline] Echo detected (${overlap}/${uWords.length} overlap): "${cleanTranscript.substring(0, 80)}"`);
        return;
      }
    }

    // Valid user turn — reset unclear-audio counter
    if (session.unclearAudioCount > 0) {
      session.unclearAudioCount = 0;
    }

    // Only send "thinking" AFTER we've confirmed this is a real user message.
    // This prevents false turns (noise/echo) from clearing the client's playback buffer.
    send({ type: "status", value: "thinking" });

    session.lastTranscription = cleanTranscript;
    session.turnCount++;
    send({ type: "transcript", role: "user", text: cleanTranscript });
    if (session.conversationId) {
      logMessage(session.tenantId, session.conversationId, "user", cleanTranscript).catch(() => {});
    }

    // First GPT call
    let result = await runGPTAndTTS(session, cleanTranscript, clientWs, t0, tSttDone);

    // If GPT returned only tool calls without text, make a follow-up call.
    // GPT needs to produce the actual spoken response after executing tools.
    if (result.hadToolCalls && !result.text.trim()) {
      if (session.ttsActive) {
        console.log("[Pipeline] Skipping follow-up — TTS already active");
        return;
      }
      console.log("[Pipeline] Tool-only response — follow-up GPT call for spoken reply");
      result = await runGPTAndTTS(
        session,
        "[Tools executed. Now respond to the visitor naturally based on what you just learned/did. Do NOT call any tools again.]",
        clientWs, t0, tSttDone,
        { maxTokens: 150 }
      );
    }

    // If still no text after follow-up, go idle
    if (!result.text.trim() && !result.ttsStarted) {
      send({ type: "status", value: "idle" });
    }

  } catch (err) {
    console.error("[Pipeline] Turn error:", err.message || err);
    send({ type: "error", message: err.message || "pipeline_error" });
    send({ type: "status", value: "idle" });
  }
}

/**
 * Generate the initial greeting.
 * Promise resolves only after TTS playback completes.
 */
async function generateGreeting(session, clientWs) {
  session.isProcessing = true;
  console.log("[Pipeline] Greeting started");

  const send = (data) => {
    try { if (clientWs.readyState === 1) clientWs.send(JSON.stringify(data)); } catch (e) {}
  };

  return new Promise(async (resolveGreeting) => {
    function finish() {
      session.cancelTTS = null;
      session.ttsEndedAt = Date.now();
      // Auto-transition to qualifying so GPT stops generating greetings
      transitionState(session, "qualifying");
      send({ type: "status", value: "idle" });
      resolveGreeting();
    }

    try {
      send({ type: "status", value: "speaking" });
      let fullText = "";
      let gptDone = false;
      let ttsStarted = false;
      const t0 = Date.now();
      const textStream = wrapStreamForTTS(createTextStream([], () => gptDone), session.language);

      await streamGPT(
        session,
        "[The visitor just arrived. Greet them the way a receptionist would greet someone walking through the door — calm, warm, not energetic. One short sentence of welcome, then ask what brings them here. Do NOT mention any specific rooms, facilities or spaces. Do NOT say 'tour'. Do NOT use any tools.]",

        (chunk) => {
          fullText += chunk;
          if (!chunk.trim()) return; // Skip whitespace-only chunks
          textStream.push(chunk);
          if (!ttsStarted && fullText.trim().split(/\s+/).length >= 4) {
            ttsStarted = true;
            startTTS(textStream, session, clientWs, t0, t0, Date.now(), finish, "greeting-stream");
          }
        },

        (toolName, args) => handleToolCall(toolName, args, session, clientWs),

        () => {
          gptDone = true;
          textStream.finish();
          if (!ttsStarted && fullText.trim()) {
            ttsStarted = true;
            startTTS(textStream, session, clientWs, t0, t0, Date.now(), finish, "greeting-done-short");
          }
          if (!fullText.trim() && !ttsStarted) finish();
          if (fullText.trim()) {
            send({ type: "transcript", role: "assistant", text: fullText });
            if (session.conversationId) {
              logMessage(session.tenantId, session.conversationId, "assistant", fullText).catch(() => {});
            }
          }
        }
      );
    } catch (err) {
      console.error("[Pipeline] Greeting error:", err.message);
      send({ type: "status", value: "idle" });
      resolveGreeting();
    }
  });
}

module.exports = { processTurn, generateGreeting };
