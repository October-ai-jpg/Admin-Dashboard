/**
 * Voice Pipeline — Sandbox Test Environment
 * Own STT (Deepgram), LLM (OpenAI), TTS (Cartesia)
 * No connection to October AI server
 */

const { transcribeAudio } = require('./stt');
const { generateResponse } = require('./llm');
const { synthesizeSpeech } = require('./tts');

function handleTestSession(ws) {
  let config = {
    systemPrompt: '',
    vertical: 'hotel',
    temperature: 0.7,
    model: 'gpt-4o-mini',
    propertyData: '',
    roomMappings: '{}'
  };
  let conversationHistory = [];
  let sessionId = 'session_' + Date.now();
  let isProcessing = false;

  ws.on('message', async (data) => {
    try {
      // Check if binary (audio) or text (config/command)
      if (typeof data === 'string' || data instanceof Buffer && data[0] === 0x7b) {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'config') {
          config = { ...config, ...msg.config };
          conversationHistory = [];
          sessionId = 'session_' + Date.now();
          ws.send(JSON.stringify({ type: 'config_ack', sessionId }));
          return;
        }

        if (msg.type === 'reset') {
          conversationHistory = [];
          sessionId = 'session_' + Date.now();
          ws.send(JSON.stringify({ type: 'reset_ack', sessionId }));
          return;
        }

        if (msg.type === 'text_input') {
          // Text-based test input
          await processUserInput(msg.text);
          return;
        }
      }

      // Binary data = PCM16 audio
      if (data instanceof Buffer && !isProcessing) {
        await processAudio(data);
      }
    } catch(e) {
      console.error('WS message error:', e);
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  async function processAudio(audioBuffer) {
    if (isProcessing) return;
    isProcessing = true;

    const timings = {};

    try {
      // 1. STT
      ws.send(JSON.stringify({ type: 'status', status: 'transcribing' }));
      const sttStart = Date.now();
      const transcript = await transcribeAudio(audioBuffer);
      timings.stt = Date.now() - sttStart;

      if (!transcript || transcript.trim().length === 0) {
        ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
        isProcessing = false;
        return;
      }

      ws.send(JSON.stringify({ type: 'transcript', role: 'user', text: transcript }));

      await processUserInput(transcript, timings);
    } catch(e) {
      console.error('Audio processing error:', e);
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
      ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
      isProcessing = false;
    }
  }

  async function processUserInput(text, timings = {}) {
    isProcessing = true;

    try {
      // Add user message to history
      conversationHistory.push({ role: 'user', content: text });

      // 2. LLM
      ws.send(JSON.stringify({ type: 'status', status: 'thinking' }));
      const llmStart = Date.now();

      const systemPrompt = buildSystemPrompt();
      const response = await generateResponse(systemPrompt, conversationHistory, config.model, config.temperature);
      timings.llm = Date.now() - llmStart;

      conversationHistory.push({ role: 'assistant', content: response });
      ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', text: response }));

      // 3. TTS
      ws.send(JSON.stringify({ type: 'status', status: 'speaking' }));
      const ttsStart = Date.now();
      const audioChunks = await synthesizeSpeech(response);
      timings.tts = Date.now() - ttsStart;

      // Send audio chunks
      for (const chunk of audioChunks) {
        if (ws.readyState === 1) {
          ws.send(chunk);
        }
      }

      timings.total = (timings.stt || 0) + timings.llm + timings.tts;

      ws.send(JSON.stringify({
        type: 'latency',
        stt: timings.stt || 0,
        llm: timings.llm,
        tts: timings.tts,
        total: timings.total
      }));

      ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
    } catch(e) {
      console.error('Processing error:', e);
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
      ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
    }

    isProcessing = false;
  }

  function buildSystemPrompt() {
    let prompt = config.systemPrompt || getDefaultPrompt(config.vertical);

    if (config.propertyData) {
      prompt += '\n\n--- PROPERTY DATA ---\n' + config.propertyData;
    }
    if (config.roomMappings && config.roomMappings !== '{}') {
      prompt += '\n\n--- ROOM MAPPINGS ---\n' + config.roomMappings;
    }
    return prompt;
  }

  ws.on('close', () => {
    console.log('Test session ended:', sessionId);
  });
}

function getDefaultPrompt(vertical) {
  const defaults = {
    hotel: `You are a virtual employee for a hotel. You are embedded inside a 3D virtual tour of the property. Your job is to greet visitors, understand what they're looking for, recommend the right room type, and guide them towards making a booking. Be warm, professional, and knowledgeable. Keep responses concise (2-3 sentences max). Ask questions to understand the guest's needs.`,
    education: `You are a virtual employee for an educational institution. You are embedded inside a 3D virtual tour of the campus. Your job is to greet prospective students, answer questions about programs, facilities, and campus life, and guide them towards scheduling a visit or applying. Be enthusiastic and informative. Keep responses concise.`,
    retail: `You are a virtual employee for a retail showroom. You are embedded inside a 3D virtual tour. Your job is to greet visitors, understand what they're looking for, highlight relevant products, and guide them towards making a purchase or booking a consultation. Be helpful and knowledgeable. Keep responses concise.`,
    real_estate_sale: `You are a virtual employee for a real estate agency. You are embedded inside a 3D virtual tour of a property for sale. Your job is to highlight key features, answer questions about the property, neighborhood, and pricing, and guide interested buyers towards scheduling a viewing. Be professional and informative. Keep responses concise.`,
    real_estate_development: `You are a virtual employee for a real estate development. You are embedded inside a 3D virtual tour of a new development project. Your job is to showcase the project, answer questions about units, amenities, and pricing, and guide interested buyers towards booking a consultation. Be professional and enthusiastic. Keep responses concise.`,
    other: `You are a virtual employee embedded inside a 3D virtual tour. Your job is to greet visitors, answer their questions, and guide them towards a conversion action. Be helpful and professional. Keep responses concise.`
  };
  return defaults[vertical] || defaults.other;
}

module.exports = { handleTestSession, getDefaultPrompt };
