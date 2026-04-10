/**
 * Voice Pipeline — Streaming Sandbox (1:1 match with October AI production)
 * Pipeline version: 3.0
 *
 * Architecture: STT → streaming LLM → streaming TTS (concurrent)
 * TTS starts playing while LLM is still generating text.
 *
 * v3 changes:
 *  - Uses production agentPersona.js for system prompt generation
 *  - System prompt regenerated per GPT call with conversation state
 *  - Fixed model (gpt-5.4-mini) and temperature (0.7) — not configurable
 *  - Session state tracking: userProfile, navigatedRooms, conversationState
 *  - Tool calls update session state (matching production pipeline)
 *  - navigate_to_room uses room_id (not room_name) matching production
 */

var { transcribeAudio, filterNoise } = require('./stt');
var { streamGPT } = require('./llm');
var { streamTTS } = require('./tts');
var { wrapStreamForTTS } = require('./ttsNormalize');
var agentPersona = require('../services/agentPersona');


/* ═══════════════════════════════════════════════════════════════
 * Text Stream Bridge — event-driven between GPT and TTS
 * (matches production pipeline.js createTextStream)
 * ═══════════════════════════════════════════════════════════════ */

function createTextStream(queue, isDone) {
  var waitResolve = null;
  var stream = {
    push: function (chunk) {
      queue.push(chunk);
      if (waitResolve) { waitResolve(); waitResolve = null; }
    },
    finish: function () {
      if (waitResolve) { waitResolve(); waitResolve = null; }
    },
    [Symbol.asyncIterator]: function () {
      return {
        next: async function () {
          while (queue.length === 0 && !isDone()) {
            await new Promise(function (r) { waitResolve = r; });
          }
          if (queue.length > 0) return { value: queue.shift(), done: false };
          return { value: undefined, done: true };
        }
      };
    }
  };
  return stream;
}


/* ═══════════════════════════════════════════════════════════════
 * Session Handler — WebSocket session lifecycle
 * ═══════════════════════════════════════════════════════════════ */

function handleTestSession(ws) {
  // Config from client (production-matching fields only)
  var config = {
    vertical: 'hotel',
    agentName: '',
    language: 'en',
    conversionUrl: '',
    compiledContext: '',
    propertyData: '',
    roomMappings: '{}',
    demoQuestions: []
  };

  // Session state (matches production voice/index.js)
  var conversationHistory = [];
  var sessionId = 'session_' + Date.now();
  var isProcessing = false;
  var turnCount = 0;
  var lastTranscription = '';
  var cancelTTS = null;
  var ttsActive = false;
  var conversationState = 'greeting';
  var userProfile = {};
  var navigatedRooms = [];
  var lastRecommendedRoom = null;
  var sessionStartedAt = Date.now();

  console.log('[SANDBOX] New streaming session connected');

  ws.on('message', async function (data) {
    try {
      // Detect JSON vs binary audio
      var isJSON = false;
      if (typeof data === 'string') {
        isJSON = true;
      } else if (Buffer.isBuffer(data) && data.length > 0 && data[0] === 0x7b) {
        isJSON = true;
      }

      if (isJSON) {
        var msg = JSON.parse(data.toString());

        if (msg.type === 'config') {
          config = {
            vertical: msg.config.vertical || 'hotel',
            agentName: msg.config.agentName || '',
            language: msg.config.language || 'en',
            conversionUrl: msg.config.conversionUrl || '',
            compiledContext: msg.config.compiledContext || '',
            propertyData: msg.config.propertyData || '',
            roomMappings: msg.config.roomMappings || '{}',
            demoQuestions: msg.config.demoQuestions || []
          };
          conversationHistory = [];
          sessionId = 'session_' + Date.now();
          turnCount = 0;
          lastTranscription = '';
          conversationState = 'greeting';
          userProfile = {};
          navigatedRooms = [];
          lastRecommendedRoom = null;
          sessionStartedAt = Date.now();
          if (cancelTTS) { cancelTTS(); cancelTTS = null; }
          ttsActive = false;
          isProcessing = false;
          console.log('[SANDBOX] Config applied — vertical:', config.vertical, 'agent:', config.agentName, 'lang:', config.language);
          safeSend({ type: 'config_ack', sessionId: sessionId });
          return;
        }

        if (msg.type === 'reset') {
          conversationHistory = [];
          sessionId = 'session_' + Date.now();
          turnCount = 0;
          lastTranscription = '';
          conversationState = 'greeting';
          userProfile = {};
          navigatedRooms = [];
          lastRecommendedRoom = null;
          sessionStartedAt = Date.now();
          if (cancelTTS) { cancelTTS(); cancelTTS = null; }
          ttsActive = false;
          isProcessing = false;
          safeSend({ type: 'reset_ack', sessionId: sessionId });
          return;
        }

        if (msg.type === 'text_input') {
          if (isProcessing) {
            safeSend({ type: 'error', message: 'Still processing previous input — please wait.' });
            return;
          }
          safeSend({ type: 'transcript', role: 'user', text: msg.text });
          await processUserInput(msg.text);
          return;
        }

        if (msg.type === 'interrupt') {
          if (cancelTTS) {
            cancelTTS();
            cancelTTS = null;
          }
          ttsActive = false;
          isProcessing = false;
          safeSend({ type: 'status', value: 'idle' });
          return;
        }

        return;
      }

      // Binary data = PCM16 audio from VAD (24kHz)
      if (Buffer.isBuffer(data) && data.length > 200 && !isProcessing && !ttsActive) {
        await processAudio(data);
      }
    } catch (e) {
      console.error('[SANDBOX] WS message error:', e.message);
      safeSend({ type: 'error', message: e.message });
    }
  });

  function safeSend(obj) {
    if (ws.readyState === 1) {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    }
  }

  function safeSendBinary(buffer) {
    if (ws.readyState === 1) {
      ws.send(buffer);
    }
  }


  /* ── Build places map from roomMappings ── */
  function getPlaces() {
    var parsedMappings = {};
    try { parsedMappings = JSON.parse(config.roomMappings || '{}'); } catch (e) {}
    var places = {};
    Object.keys(parsedMappings).forEach(function(key) {
      var entry = parsedMappings[key];
      places[key] = typeof entry === 'object' ? (entry.label || key) : entry;
    });
    return places;
  }


  /* ── Build system prompt using production agentPersona ── */
  function generateSystemPrompt() {
    var parsedMappings = {};
    try { parsedMappings = JSON.parse(config.roomMappings || '{}'); } catch (e) {}
    var places = getPlaces();
    var elapsedMinutes = Math.round((Date.now() - sessionStartedAt) / 60000);

    return agentPersona.buildSystemPrompt({
      vertical: config.vertical,
      propertyName: config.agentName,
      places: places,
      compiledContext: config.compiledContext || config.propertyData || '',
      language: config.language || 'en',
      dateTime: new Date().toLocaleString('en-GB', { timeZone: 'Europe/Copenhagen' }),
      conversationState: conversationState,
      userProfile: userProfile,
      navigatedRooms: navigatedRooms,
      lastRecommendedRoom: lastRecommendedRoom,
      turnCount: turnCount,
      elapsedMinutes: elapsedMinutes,
      roomMappings: parsedMappings,
      propertyDetails: null
    });
  }


  /* ── Build tools using production agentPersona ── */
  function generateTools() {
    var places = getPlaces();
    return agentPersona.buildTools({
      places: places,
      vertical: config.vertical
    });
  }


  /* ── STT Processing ── */
  async function processAudio(audioBuffer) {
    if (isProcessing) return;
    isProcessing = true;
    var timings = {};

    try {
      safeSend({ type: 'status', value: 'transcribing' });
      var sttStart = Date.now();
      var sttResult = await transcribeAudio(audioBuffer);
      timings.stt = Date.now() - sttStart;

      var transcript = sttResult.text;
      var confidence = sttResult.confidence;

      console.log('[SANDBOX] STT: "' + transcript + '" (' + timings.stt + 'ms, conf=' + confidence.toFixed(2) + ')');

      // Noise filtering (matches production)
      var filterResult = filterNoise(transcript, lastTranscription, confidence);
      if (filterResult.filtered) {
        console.log('[SANDBOX] Filtered (' + filterResult.reason + '): "' + transcript + '"');
        safeSend({ type: 'status', value: 'idle' });
        isProcessing = false;
        return;
      }

      var cleanTranscript = filterResult.text;

      // Echo detection (matches production)
      var lastAssistantMsg = null;
      for (var i = conversationHistory.length - 1; i >= 0; i--) {
        if (conversationHistory[i].role === 'assistant') {
          lastAssistantMsg = conversationHistory[i];
          break;
        }
      }
      if (lastAssistantMsg) {
        var assistantWords = lastAssistantMsg.content.toLowerCase().split(/\s+/).slice(0, 15).join(' ');
        var userWords = cleanTranscript.toLowerCase().split(/\s+/).slice(0, 15).join(' ');
        var aSet = {};
        assistantWords.split(' ').forEach(function (w) { aSet[w] = true; });
        var uWords = userWords.split(' ');
        var overlap = uWords.filter(function (w) { return aSet[w]; }).length;
        if (uWords.length >= 3 && overlap / uWords.length > 0.6) {
          console.log('[SANDBOX] Echo detected (' + overlap + '/' + uWords.length + ' overlap)');
          safeSend({ type: 'status', value: 'idle' });
          isProcessing = false;
          return;
        }
      }

      lastTranscription = cleanTranscript;
      safeSend({ type: 'transcript', role: 'user', text: cleanTranscript });
      safeSend({ type: 'status', value: 'thinking' });
      await processUserInput(cleanTranscript, timings);
    } catch (e) {
      console.error('[SANDBOX] STT error:', e.message);
      safeSend({ type: 'error', message: 'Speech-to-text error: ' + e.message });
      safeSend({ type: 'status', value: 'idle' });
      isProcessing = false;
    }
  }


  /* ── Streaming LLM + TTS Processing ── */
  async function processUserInput(text, timings) {
    if (!timings) timings = {};
    isProcessing = true;
    turnCount++;
    var currentTurn = turnCount;
    var toolsUsed = [];

    try {
      conversationHistory.push({ role: 'user', content: text });

      // Trim history to 16 turns (matches production contextTurns)
      while (conversationHistory.length > 16) {
        conversationHistory.shift();
      }

      // Generate system prompt using production agentPersona (regenerated per call)
      var systemPrompt = generateSystemPrompt();

      // Generate tools using production agentPersona
      var tools = generateTools();

      safeSend({ type: 'status', value: 'thinking' });
      var llmStart = Date.now();

      console.log('[SANDBOX] Turn ' + currentTurn + ' — streaming GPT (gpt-5.4-mini, temp=0.7, state=' + conversationState + ')');

      // Run streaming GPT + concurrent TTS
      var result = await runStreamingTurn(systemPrompt, tools, timings, llmStart);

      timings.llm = result.llmMs;
      timings.tts = result.ttsMs;

      // Handle tool calls — if GPT returned tools but no text, do follow-up
      if (result.hadToolCalls) {
        for (var i = 0; i < result.toolResults.length; i++) {
          toolsUsed.push(result.toolResults[i]);
        }

        if (!result.text.trim()) {
          console.log('[SANDBOX] Tool-only response — follow-up GPT for spoken reply');
          conversationHistory.push({
            role: 'user',
            content: '[Tools executed. Now respond to the visitor naturally based on what you just learned/did. Do NOT call any tools again.]'
          });

          var followStart = Date.now();
          var followResult = await runStreamingTurn(generateSystemPrompt(), tools, timings, followStart);
          timings.llm += followResult.llmMs;
          timings.tts = followResult.ttsMs;
          result.text = followResult.text;
        }
      }

      // Store assistant response in history
      var responseText = result.text || 'I apologize, I could not generate a response.';
      conversationHistory.push({ role: 'assistant', content: responseText });
      safeSend({ type: 'transcript', role: 'assistant', text: responseText });

      // Wait for TTS to finish before going idle
      if (!ttsActive) {
        safeSend({ type: 'status', value: 'idle' });
      }

      // Debug timing event
      timings.total = (timings.stt || 0) + (timings.llm || 0) + (timings.tts || 0);
      safeSend({
        type: 'debug',
        turn: currentTurn,
        sttMs: timings.stt || 0,
        sttText: text,
        llmMs: timings.llm || 0,
        llmFirstTokens: responseText.substring(0, 80),
        ttsMs: timings.tts || 0,
        totalMs: timings.total,
        temperature: 0.7,
        model: 'gpt-5.4-mini',
        toolsCalled: toolsUsed,
        state: conversationState
      });

    } catch (e) {
      console.error('[SANDBOX] Processing error:', e.message);
      safeSend({ type: 'error', message: e.message });
      safeSend({ type: 'status', value: 'idle' });
    }

    if (!ttsActive) {
      isProcessing = false;
    }
  }


  /* ── Run one streaming GPT → TTS turn ── */
  async function runStreamingTurn(systemPrompt, tools, timings, llmStart) {
    return new Promise(async function (resolve) {
      var fullText = '';
      var gptDone = false;
      var ttsStarted = false;
      var hadToolCalls = false;
      var toolResults = [];
      var repeating = false;
      var tGptFirst = 0;
      var ttsMs = 0;
      var ttsStartTime = 0;
      var resolved = false;

      var parsedMappings = {};
      try { parsedMappings = JSON.parse(config.roomMappings || '{}'); } catch (e) {}

      // Text stream bridge: LLM pushes text → TTS consumes it
      var textStream = wrapStreamForTTS(createTextStream([], function () { return gptDone; }));

      // Tool call leak detection (safety-net)
      var TOOL_LEAK_BRACKET = /\[\s*(navigate|trigger|update|functions)/;
      var TOOL_LEAK_BARE = /\b(navigate_to_room|trigger_conversion|update_user_profile|update_conversation_state)\b/;

      function doResolve() {
        if (resolved) return;
        resolved = true;
        var llmMs = Date.now() - llmStart;
        resolve({ text: fullText, hadToolCalls: hadToolCalls, toolResults: toolResults, llmMs: llmMs, ttsMs: ttsMs });
      }

      try {
        await streamGPT(
          {
            systemPrompt: systemPrompt,
            messages: conversationHistory,
            model: 'gpt-5.4-mini',
            temperature: 0.7,
            tools: tools,
            maxTokens: 200
          },

          // onTextChunk
          function (chunk) {
            if (!tGptFirst) tGptFirst = Date.now();

            fullText += chunk;

            // Safety-net leak detection
            if (!repeating && (TOOL_LEAK_BRACKET.test(fullText) || TOOL_LEAK_BARE.test(fullText))) {
              console.warn('[SANDBOX] Tool leak detected (safety-net):', fullText.substring(0, 100));
              repeating = true;
              return;
            }

            // Repetition detection (matches production)
            if (!repeating && fullText.length > 60) {
              var dotIdx = fullText.indexOf('.');
              if (dotIdx > 10 && dotIdx < fullText.length - 10) {
                var first = fullText.substring(0, dotIdx + 1).trim();
                var rest = fullText.substring(dotIdx + 1).trim();
                var cmp = first.substring(0, Math.min(40, first.length));
                if (rest.length >= cmp.length && rest.substring(0, cmp.length) === cmp) {
                  console.warn('[SANDBOX] Sentence repetition detected');
                  repeating = true;
                }
              }
              if (!repeating && fullText.length > 120) {
                var prefix = fullText.substring(0, 40);
                var repeatIdx = fullText.indexOf(prefix, 40);
                if (repeatIdx > 0) {
                  console.warn('[SANDBOX] Full-response repetition at pos ' + repeatIdx);
                  repeating = true;
                }
              }
            }
            if (repeating) return;

            // Skip whitespace-only chunks
            if (!chunk.trim()) return;

            textStream.push(chunk);

            // Start TTS when we have enough text (4 words, matches production)
            if (!ttsStarted && !ttsActive && fullText.trim().split(/\s+/).length >= 4) {
              ttsStarted = true;
              ttsStartTime = Date.now();
              startTTSStream(textStream, function () {
                ttsMs = Date.now() - ttsStartTime;
                doResolve();
              });
            }
          },

          // onToolCall
          function (toolName, args) {
            hadToolCalls = true;
            var result = handleToolCall(toolName, args, parsedMappings);
            toolResults.push({ name: toolName, args: args, result: result });
          },

          // onDone
          function (finalText) {
            gptDone = true;

            // Clean corrupted text
            if (repeating) {
              var bracketIdx = fullText.lastIndexOf('[');
              if (bracketIdx > 0) {
                fullText = fullText.substring(0, bracketIdx).trim();
              } else {
                var prefix2 = fullText.substring(0, Math.min(40, fullText.length));
                var rIdx = fullText.indexOf(prefix2, 40);
                if (rIdx > 0) fullText = fullText.substring(0, rIdx).trim();
              }
            }

            textStream.finish();

            // Short text — start TTS now
            if (!ttsStarted && !ttsActive && fullText.trim()) {
              ttsStarted = true;
              ttsStartTime = Date.now();
              startTTSStream(textStream, function () {
                ttsMs = Date.now() - ttsStartTime;
                doResolve();
              });
            }

            // No text at all (tool-only)
            if (!ttsStarted) {
              doResolve();
            }
          }
        );
      } catch (e) {
        gptDone = true;
        textStream.finish();
        console.error('[SANDBOX] streamGPT error:', e.message);
        doResolve();
      }
    });
  }


  /* ── Start TTS Streaming ── */
  function startTTSStream(textStream, onFinish) {
    if (cancelTTS) {
      console.warn('[SANDBOX] Cancelling existing TTS before starting new stream');
      cancelTTS();
      cancelTTS = null;
    }

    ttsActive = true;
    safeSend({ type: 'status', value: 'speaking' });
    var ttsStart = Date.now();

    cancelTTS = streamTTS(
      textStream,

      // onAudioChunk — send binary PCM16 directly to client
      function (pcm16Chunk) {
        safeSendBinary(pcm16Chunk);
      },

      // onDone
      function () {
        console.log('[SANDBOX] TTS done (' + (Date.now() - ttsStart) + 'ms)');
        ttsActive = false;
        isProcessing = false;
        cancelTTS = null;
        safeSend({ type: 'status', value: 'idle' });
        if (onFinish) onFinish();
      },

      // onError
      function (err) {
        console.error('[SANDBOX] TTS error:', err);
        ttsActive = false;
        isProcessing = false;
        cancelTTS = null;
        safeSend({ type: 'status', value: 'idle' });
        if (onFinish) onFinish();
      }
    );
  }


  /* ── Tool Call Handler (matches production pipeline.js handleToolCall) ── */
  function handleToolCall(toolName, args, roomMappings) {
    console.log('[SANDBOX] Tool call:', toolName, JSON.stringify(args));

    if (toolName === 'navigate_to_room') {
      // Production uses room_id (the key in roomMappings), not room_name
      var roomId = args.room_id || '';
      var entry = roomMappings[roomId];
      var sweepId = null;
      var roomLabel = roomId;

      if (entry) {
        sweepId = (typeof entry === 'object') ? (entry.sweepId || entry.sweep_id) : null;
        roomLabel = (typeof entry === 'object') ? (entry.label || roomId) : entry;
      }

      // Track navigated rooms (matching production)
      if (roomId && navigatedRooms.indexOf(roomId) === -1) {
        navigatedRooms.push(roomId);
      }
      lastRecommendedRoom = roomId;

      safeSend({ type: 'navigate', sweepId: sweepId, roomName: roomLabel, roomId: roomId });
      if (sweepId) {
        return { success: true, message: 'Navigating the tour to ' + roomLabel };
      } else {
        return { success: false, message: 'Room not found in tour mappings: ' + roomId };
      }
    }

    if (toolName === 'trigger_conversion') {
      // Update conversation state to closing (matching production)
      conversationState = 'closing';
      safeSend({ type: 'conversion', reason: args.message || args.reason });
      safeSend({ type: 'state_change', state: 'closing', reason: 'conversion triggered' });
      return { success: true, message: 'Booking page opened for visitor' };
    }

    if (toolName === 'update_user_profile') {
      // Track user profile (matching production)
      if (args.field && args.value) {
        userProfile[args.field] = args.value;
      }
      safeSend({ type: 'profile_update', field: args.field, value: args.value });
      console.log('[SANDBOX] Profile update:', args.field, '=', args.value);
      return { success: true, message: 'Noted: ' + args.field + ' = ' + args.value };
    }

    if (toolName === 'update_conversation_state') {
      if (args.new_state) {
        conversationState = args.new_state;
        console.log('[SANDBOX] State → ' + conversationState + ' — ' + (args.reason || ''));
        safeSend({ type: 'state_change', state: conversationState, reason: args.reason });
      }
      return { success: true, message: 'State updated to ' + args.new_state };
    }

    if (toolName === 'set_view_mode') {
      safeSend({ type: 'set_view_mode', mode: args.mode });
      console.log('[SANDBOX] View mode → ' + args.mode);
      return { success: true, message: 'View mode set to ' + args.mode };
    }

    return { success: false, message: 'Unknown tool: ' + toolName };
  }


  ws.on('close', function () {
    console.log('[SANDBOX] Session ended:', sessionId, '— Turns:', turnCount, '— State:', conversationState);
    if (cancelTTS) { cancelTTS(); cancelTTS = null; }
  });
}


module.exports = { handleTestSession };
