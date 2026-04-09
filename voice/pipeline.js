/**
 * Voice Pipeline — Sandbox Test Environment
 * STT (Deepgram) → LLM (OpenAI with tools) → TTS (Cartesia)
 * No connection to October AI server — fully self-contained.
 */

const { transcribeAudio } = require('./stt');
const { generateResponse } = require('./llm');
const { synthesizeSpeech } = require('./tts');

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

  console.log('[SANDBOX] New test session connected');

  ws.on('message', async function(data) {
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
          console.log('[SANDBOX] Config applied — vertical:', config.vertical, 'model:', config.model, 'temperature:', config.temperature);
          safeSend({ type: 'config_ack', sessionId: sessionId });
          return;
        }

        if (msg.type === 'reset') {
          conversationHistory = [];
          sessionId = 'session_' + Date.now();
          turnCount = 0;
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
        return;
      }

      // Binary data = PCM16 audio from microphone
      if (Buffer.isBuffer(data) && data.length > 200 && !isProcessing) {
        await processAudio(data);
      }
    } catch(e) {
      console.error('[SANDBOX] WS message error:', e.message);
      safeSend({ type: 'error', message: e.message });
    }
  });

  function safeSend(obj) {
    if (ws.readyState === 1) {
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    }
  }

  async function processAudio(audioBuffer) {
    if (isProcessing) return;
    isProcessing = true;
    var timings = {};

    try {
      safeSend({ type: 'status', status: 'transcribing' });
      var sttStart = Date.now();
      var transcript = await transcribeAudio(audioBuffer);
      timings.stt = Date.now() - sttStart;

      if (!transcript || transcript.trim().length === 0) {
        safeSend({ type: 'status', status: 'idle' });
        isProcessing = false;
        return;
      }

      safeSend({ type: 'transcript', role: 'user', text: transcript });
      await processUserInput(transcript, timings);
    } catch(e) {
      console.error('[SANDBOX] STT error:', e.message);
      safeSend({ type: 'error', message: 'Speech-to-text error: ' + e.message });
      safeSend({ type: 'status', status: 'idle' });
      isProcessing = false;
    }
  }

  async function processUserInput(text, timings) {
    if (!timings) timings = {};
    isProcessing = true;
    turnCount++;
    var currentTurn = turnCount;
    var toolsUsed = [];

    try {
      conversationHistory.push({ role: 'user', content: text });

      // --- LLM ---
      safeSend({ type: 'status', status: 'thinking' });
      var llmStart = Date.now();
      var systemPrompt = buildSystemPrompt();
      var parsedMappings = {};
      try { parsedMappings = JSON.parse(config.roomMappings || '{}'); } catch(e) {}

      console.log('[SANDBOX] Starting turn', currentTurn, 'with temperature:', config.temperature, 'model:', config.model);

      var result = await generateResponse(
        systemPrompt,
        conversationHistory,
        config.model,
        config.temperature,
        parsedMappings
      );
      timings.llm = Date.now() - llmStart;

      // --- Handle tool calls ---
      if (result.toolCalls && result.toolCalls.length > 0) {
        // Add assistant message with tool_calls to history
        conversationHistory.push(result.message);

        for (var i = 0; i < result.toolCalls.length; i++) {
          var tc = result.toolCalls[i];
          var toolResult = handleToolCall(tc, parsedMappings);
          var tcArgs = {};
          try { tcArgs = JSON.parse(tc.function.arguments || '{}'); } catch(e) {}
          toolsUsed.push({ name: tc.function.name, args: tcArgs });

          conversationHistory.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult)
          });
        }

        // Follow-up LLM call for spoken response after tool execution
        console.log('[SANDBOX] Tool-only response — follow-up LLM call for spoken reply');
        var followStart = Date.now();
        result = await generateResponse(
          systemPrompt,
          conversationHistory,
          config.model,
          config.temperature,
          parsedMappings
        );
        timings.llm += Date.now() - followStart;

        // Check for additional tool calls in follow-up
        if (result.toolCalls && result.toolCalls.length > 0) {
          conversationHistory.push(result.message);
          for (var j = 0; j < result.toolCalls.length; j++) {
            var tc2 = result.toolCalls[j];
            var tr2 = handleToolCall(tc2, parsedMappings);
            var args2 = {};
            try { args2 = JSON.parse(tc2.function.arguments || '{}'); } catch(e) {}
            toolsUsed.push({ name: tc2.function.name, args: args2 });
            conversationHistory.push({
              role: 'tool',
              tool_call_id: tc2.id,
              content: JSON.stringify(tr2)
            });
          }
          var follow2Start = Date.now();
          result = await generateResponse(systemPrompt, conversationHistory, config.model, config.temperature, parsedMappings);
          timings.llm += Date.now() - follow2Start;
        }
      }

      var responseText = result.text || 'I apologize, I could not generate a response.';
      conversationHistory.push({ role: 'assistant', content: responseText });
      safeSend({ type: 'transcript', role: 'assistant', text: responseText });

      // --- TTS ---
      safeSend({ type: 'status', status: 'speaking' });
      var ttsStart = Date.now();
      var audioChunks = await synthesizeSpeech(responseText);
      timings.tts = Date.now() - ttsStart;

      for (var k = 0; k < audioChunks.length; k++) {
        if (ws.readyState === 1) ws.send(audioChunks[k]);
      }
      safeSend({ type: 'audio_end' });

      // --- Latency + Debug ---
      timings.total = (timings.stt || 0) + timings.llm + timings.tts;
      safeSend({ type: 'latency', stt: timings.stt || 0, llm: timings.llm, tts: timings.tts, total: timings.total });
      safeSend({
        type: 'debug',
        turn: currentTurn,
        sttMs: timings.stt || 0,
        sttText: text,
        llmMs: timings.llm,
        llmFirstTokens: responseText.substring(0, 80),
        ttsMs: timings.tts,
        totalMs: timings.total,
        temperature: config.temperature,
        model: config.model,
        toolsCalled: toolsUsed
      });

      safeSend({ type: 'status', status: 'idle' });
    } catch(e) {
      console.error('[SANDBOX] Processing error:', e.message);
      safeSend({ type: 'error', message: e.message });
      safeSend({ type: 'status', status: 'idle' });
    }

    isProcessing = false;
  }

  function handleToolCall(toolCall, roomMappings) {
    var name = toolCall.function.name;
    var args = {};
    try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch(e) {}
    console.log('[SANDBOX] Tool call:', name, JSON.stringify(args));

    if (name === 'navigate_to_room') {
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

    if (name === 'trigger_conversion') {
      safeSend({ type: 'conversion', reason: args.reason });
      return { success: true, message: 'Booking page opened for visitor' };
    }

    if (name === 'update_user_profile') {
      safeSend({ type: 'profile_update', field: args.field, value: args.value });
      console.log('[SANDBOX] Profile update:', args.field, '=', args.value);
      return { success: true, message: 'Noted: ' + args.field + ' = ' + args.value };
    }

    return { success: false, message: 'Unknown tool: ' + name };
  }

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
          var roomList = keys.map(function(key) {
            var val = mappings[key];
            var label = (typeof val === 'string') ? val : (val.label || key);
            return '- ' + label;
          }).join('\n');
          prompt += '\n\n--- AVAILABLE ROOMS/SPACES ---\nYou can navigate the virtual tour to show these spaces:\n' + roomList;
          prompt += '\nUse the navigate_to_room tool when the visitor wants to see a specific room or when you want to recommend one.';
        }
      } catch(e) {}
    }

    prompt += '\n\nIMPORTANT: Keep responses concise (2-3 sentences max). You are having a real-time voice conversation.';
    return prompt;
  }

  ws.on('close', function() {
    console.log('[SANDBOX] Session ended:', sessionId, '— Turns:', turnCount);
  });
}

function getDefaultPrompt(vertical) {
  var defaults = {
    hotel: 'You are a virtual employee for a hotel. You are embedded inside a 3D virtual tour of the property. Your job is to greet visitors, understand what they are looking for, recommend the right room type, and guide them towards making a booking. Be warm, professional, and knowledgeable. Keep responses concise (2-3 sentences max). Ask questions to understand the guest needs.',
    education: 'You are a virtual employee for an educational institution. You are embedded inside a 3D virtual tour of the campus. Your job is to greet prospective students, answer questions about programs, facilities, and campus life, and guide them towards scheduling a visit or applying. Be enthusiastic and informative. Keep responses concise.',
    retail: 'You are a virtual employee for a retail showroom. You are embedded inside a 3D virtual tour. Your job is to greet visitors, understand what they are looking for, highlight relevant products, and guide them towards making a purchase or booking a consultation. Be helpful and knowledgeable. Keep responses concise.',
    real_estate_sale: 'You are a virtual employee for a real estate agency. You are embedded inside a 3D virtual tour of a property for sale. Your job is to highlight key features, answer questions about the property, neighborhood, and pricing, and guide interested buyers towards scheduling a viewing. Be professional and informative. Keep responses concise.',
    real_estate_development: 'You are a virtual employee for a real estate development. You are embedded inside a 3D virtual tour of a new development project. Your job is to showcase the project, answer questions about units, amenities, and pricing, and guide interested buyers towards booking a consultation. Be professional and enthusiastic. Keep responses concise.',
    other: 'You are a virtual employee embedded inside a 3D virtual tour. Your job is to greet visitors, answer their questions, and guide them towards a conversion action. Be helpful and professional. Keep responses concise.'
  };
  return defaults[vertical] || defaults.other;
}

module.exports = { handleTestSession, getDefaultPrompt };
