/**
 * Voice Pipeline — Streaming Sandbox (matches October AI production architecture)
 * Pipeline version: 2.0
 *
 * Architecture: STT → streaming LLM → streaming TTS (concurrent)
 * TTS starts playing while LLM is still generating text.
 *
 * Changes from v1:
 *  - Streaming pipeline instead of sequential batch
 *  - Text stream bridge between LLM and TTS
 *  - Currency normalization via ttsNormalize
 *  - Noise filtering via stt.filterNoise
 *  - Echo detection (word-overlap)
 *  - Repetition detection + TTS feed cutoff
 *  - Tool call leak detection (safety-net on top of LLM suppressor)
 *  - Debug timing events with per-turn breakdown
 *  - 5 tools matching production
 */

var { transcribeAudio, filterNoise } = require('./stt');
var { streamGPT, buildTools } = require('./llm');
var { streamTTS } = require('./tts');
var { wrapStreamForTTS } = require('./ttsNormalize');


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
 * Default System Prompts by Vertical
 * ═══════════════════════════════════════════════════════════════ */

function getDefaultPrompt(vertical) {
  var defaults = {
    hotel: 'You are a virtual concierge for a hotel. You are embedded inside a 3D virtual tour of the property. Your job is to greet visitors, understand what they are looking for, recommend the right room type, and guide them towards making a booking. Be warm, professional, and knowledgeable. Keep responses concise (2-3 sentences max). Ask questions to understand the guest needs. Always end with a question.',
    education: 'You are a virtual enrollment advisor for an educational institution. You are embedded inside a 3D virtual tour of the campus. Your job is to greet prospective students, answer questions about programs, facilities, and campus life, and guide them towards scheduling a visit or applying. Be enthusiastic and informative. Keep responses concise.',
    retail: 'You are a virtual showroom advisor. You are embedded inside a 3D virtual tour. Your job is to greet visitors, understand what they are looking for, highlight relevant products, and guide them towards making a purchase or booking a consultation. Be helpful and knowledgeable. Keep responses concise.',
    real_estate_sale: 'You are a virtual property advisor. You are embedded inside a 3D virtual tour of a property for sale. Your job is to highlight key features, answer questions about the property, neighborhood, and pricing, and guide interested buyers towards scheduling a viewing. Be professional and informative. Keep responses concise.',
    real_estate_development: 'You are a virtual project advisor for a real estate development. You are embedded inside a 3D virtual tour of a new development project. Your job is to showcase the project, answer questions about units, amenities, and pricing, and guide interested buyers towards booking a consultation. Be professional and enthusiastic. Keep responses concise.',
    other: 'You are a virtual employee embedded inside a 3D virtual tour. Your job is to greet visitors, answer their questions, and guide them towards a conversion action. Be helpful and professional. Keep responses concise.'
  };
  return defaults[vertical] || defaults.other;
}


/* ═══════════════════════════════════════════════════════════════
 * Session Handler — WebSocket session lifecycle
 * ═══════════════════════════════════════════════════════════════ */

function handleTestSession(ws) {
  var config = {
    systemPrompt: '',
    vertical: 'hotel',
    temperature: 0.7,
    model: 'gpt-5.4-mini',
    propertyData: '',
    roomMappings: '{}'
  };
  var conversationHistory = [];
  var sessionId = 'session_' + Date.now();
  var isProcessing = false;
  var turnCount = 0;
  var lastTranscription = '';
  var cancelTTS = null;
  var ttsActive = false;
  var conversationState = 'greeting';

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
            systemPrompt: msg.config.systemPrompt || '',
            vertical: msg.config.vertical || 'hotel',
            temperature: parseFloat(msg.config.temperature) || 0.7,
            model: msg.config.model || 'gpt-5.4-mini',
            propertyData: msg.config.propertyData || '',
            roomMappings: msg.config.roomMappings || '{}'
          };
          conversationHistory = [];
          sessionId = 'session_' + Date.now();
          turnCount = 0;
          lastTranscription = '';
          conversationState = 'greeting';
          if (cancelTTS) { cancelTTS(); cancelTTS = null; }
          ttsActive = false;
          isProcessing = false;
          console.log('[SANDBOX] Config applied — vertical:', config.vertical, 'model:', config.model, 'temperature:', config.temperature);
          safeSend({ type: 'config_ack', sessionId: sessionId });
          return;
        }

        if (msg.type === 'reset') {
          conversationHistory = [];
          sessionId = 'session_' + Date.now();
          turnCount = 0;
          lastTranscription = '';
          conversationState = 'greeting';
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

      // Trim history to 20 turns (matches production)
      while (conversationHistory.length > 20) {
        conversationHistory.shift();
      }

      // Build system prompt
      var systemPrompt = buildSystemPrompt();

      // Build tools
      var parsedMappings = {};
      try { parsedMappings = JSON.parse(config.roomMappings || '{}'); } catch (e) {}
      var tools = buildTools(parsedMappings, config.vertical);

      safeSend({ type: 'status', value: 'thinking' });
      var llmStart = Date.now();

      console.log('[SANDBOX] Turn ' + currentTurn + ' — streaming GPT (' + config.model + ', temp=' + config.temperature + ')');

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
          var followResult = await runStreamingTurn(systemPrompt, tools, timings, followStart);
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
        temperature: config.temperature,
        model: config.model,
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
            model: config.model,
            temperature: config.temperature,
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


  /* ── Tool Call Handler ── */
  function handleToolCall(toolName, args, roomMappings) {
    console.log('[SANDBOX] Tool call:', toolName, JSON.stringify(args));

    if (toolName === 'navigate_to_room') {
      var sweepId = null;
      var roomName = (args.room_name || '').toLowerCase();
      if (roomMappings) {
        for (var key in roomMappings) {
          var val = roomMappings[key];
          var label = (typeof val === 'string') ? val : (val.label || key);
          if (label.toLowerCase().includes(roomName) || roomName.includes(label.toLowerCase())) {
            sweepId = (typeof val === 'string') ? key : (val.sweepId || val.sweep_id || key);
            break;
          }
        }
      }
      safeSend({ type: 'navigate', sweepId: sweepId, roomName: args.room_name });
      if (sweepId) {
        return { success: true, message: 'Navigating the tour to ' + args.room_name };
      } else {
        return { success: false, message: 'Room not found in tour mappings: ' + args.room_name };
      }
    }

    if (toolName === 'trigger_conversion') {
      safeSend({ type: 'conversion', reason: args.reason });
      return { success: true, message: 'Booking page opened for visitor' };
    }

    if (toolName === 'update_user_profile') {
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


  /* ── Build System Prompt ── */
  function buildSystemPrompt() {
    var prompt = config.systemPrompt || getDefaultPrompt(config.vertical);

    if (config.propertyData) {
      prompt += '\n\n--- PROPERTY DATA ---\n' + config.propertyData;
    }

    if (config.roomMappings && config.roomMappings !== '{}') {
      try {
        var mappings = JSON.parse(config.roomMappings);
        var keys = Object.keys(mappings);
        if (keys.length > 0) {
          var roomList = keys.map(function (key) {
            var val = mappings[key];
            var label = (typeof val === 'string') ? val : (val.label || key);
            return '- ' + label;
          }).join('\n');
          prompt += '\n\n--- AVAILABLE ROOMS/SPACES ---\nYou can navigate the virtual tour to show these spaces:\n' + roomList;
          prompt += '\nUse the navigate_to_room tool when the visitor wants to see a specific room or when you want to recommend one.';
        }
      } catch (e) {}
    }

    prompt += '\n\nIMPORTANT: Keep responses concise (2-3 sentences max). You are having a real-time voice conversation. Always include spoken text AND tool calls in the same response — never return only a tool call without text.';
    prompt += '\nConversation state: ' + conversationState + ' | Turn: ' + turnCount;

    return prompt;
  }


  ws.on('close', function () {
    console.log('[SANDBOX] Session ended:', sessionId, '— Turns:', turnCount);
    if (cancelTTS) { cancelTTS(); cancelTTS = null; }
  });
}


module.exports = { handleTestSession, getDefaultPrompt };
