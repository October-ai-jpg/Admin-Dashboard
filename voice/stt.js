/**
 * STT — Deepgram Nova-3 (matches October AI production)
 * Pipeline version: 2.0
 *
 * Changes from v1:
 *  - Nova-3 instead of Nova-2
 *  - 24kHz sample rate with WAV wrapping (instead of raw 16kHz)
 *  - Returns { text, confidence, words } instead of plain string
 *  - Adds filterNoise() for hallucination/ambient/echo filtering
 *  - AbortController timeout (8s)
 */

const STT_TIMEOUT_MS = 8000;

/**
 * Convert PCM16 buffer (24kHz mono 16-bit) to WAV format.
 */
function pcm16ToWav(pcmBuffer) {
  var sampleRate = 24000;
  var channels = 1;
  var byteRate = sampleRate * channels * 2;
  var blockAlign = channels * 2;
  var dataSize = pcmBuffer.length;

  var header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Transcribe PCM16 audio via Deepgram Nova-3.
 *
 * @param {Buffer} pcm16Buffer - Raw PCM16 24kHz mono audio
 * @param {string} [language='en'] - ISO language code
 * @returns {{ text: string, language: string, confidence: number, words: Array }}
 */
async function transcribeAudio(pcm16Buffer, language) {
  if (!language) language = 'en';
  var apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured');

  // Minimum ~500ms of audio at 24kHz 16-bit mono = 24000 bytes
  if (pcm16Buffer.length < 24000) {
    throw new Error('STT_AUDIO_TOO_SHORT');
  }

  var wavBuffer = pcm16ToWav(pcm16Buffer);

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, STT_TIMEOUT_MS);

  try {
    var url = 'https://api.deepgram.com/v1/listen?model=nova-3&language=' + language + '&smart_format=true';
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + apiKey,
        'Content-Type': 'audio/wav'
      },
      body: wavBuffer,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      var errBody = await res.text().catch(function () { return ''; });
      console.error('[STT] Deepgram error:', res.status, errBody.substring(0, 200));
      throw new Error('STT_DEEPGRAM_ERROR:' + res.status);
    }

    var result = await res.json();
    var alt = result.results?.channels?.[0]?.alternatives?.[0];
    var text = (alt?.transcript || '').trim();
    var confidence = alt?.confidence ?? 1.0;
    var words = alt?.words || [];

    return { text: text, language: language, confidence: confidence, words: words };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('STT_TIMEOUT');
    throw err;
  }
}


/* ═══════════════════════════════════════════════════════════════
 * Noise Filtering (matches production exactly)
 * ═══════════════════════════════════════════════════════════════ */

var ACK_PATTERN = /^(yes|no|sure|okay|ok|thanks|thank you|great|perfect|sounds good|alright|got it|right|exactly|yeah|yep|nope|fine|good|nice|cool|awesome|wonderful|lovely|hi|hello|hey|hi there|hey there|good morning|good afternoon|good evening|bye|goodbye|see you|take care|ciao|hej|hola|bonjour|ja|nej|tak|hej hej|godmorgen|godaften)\.?$/i;

var HALLUCINATION_PATTERN = /^(you|to|the|a|an|i|it|is|and|that|this|but|for|with|so|do|if|my|or|we|at|in|on|be|go|of|up|by|as|us|am|oh|ah|uh|um|hm|hmm|ha|eh|er|mhm)\.?$/i;

var MIN_CONFIDENCE = 0.65;

var AMBIENT_NOISE_PATTERNS = [
  /\b\d{4}\b.*\b\d{4}\b/,
  /\b(chapter|verse|psalm|genesis|exodus)\b/i,
  /\b(subscribe|like and|click|notification|comment below)\b/i,
  /♪|🎵|🎶|la la la|do do do|na na na/i,
  /\b(ladies and gentlemen|stay tuned|coming up next|commercial break)\b/i,
  /\b(www\.|\.com|\.org|\.net|http)\b/i,
  /\b(terms and conditions|privacy policy|all rights reserved)\b/i
];

/**
 * Filter noise and non-speech transcriptions.
 * @returns {{ filtered: boolean, reason: string|null, text: string }}
 */
function filterNoise(rawTranscript, lastTranscription, confidence) {
  if (lastTranscription === undefined) lastTranscription = '';
  if (confidence === undefined) confidence = 1.0;

  var text = (rawTranscript || '').trim();

  if (!text) return { filtered: true, reason: 'empty', text: text };
  if (confidence < MIN_CONFIDENCE) return { filtered: true, reason: 'low_confidence', text: text };
  if (HALLUCINATION_PATTERN.test(text)) return { filtered: true, reason: 'hallucination', text: text };
  if (ACK_PATTERN.test(text)) return { filtered: false, reason: null, text: text };

  var wordCount = text.split(/\s+/).filter(function (w) { return w.length > 0; }).length;
  if (wordCount < 2) return { filtered: true, reason: 'too_short', text: text };

  for (var i = 0; i < AMBIENT_NOISE_PATTERNS.length; i++) {
    if (AMBIENT_NOISE_PATTERNS[i].test(text)) return { filtered: true, reason: 'ambient_noise', text: text };
  }

  if (wordCount > 40 && confidence < 0.85) return { filtered: true, reason: 'long_ambient', text: text };
  if (/^https?:\/\//i.test(text) || /^www\./i.test(text)) return { filtered: true, reason: 'url_noise', text: text };
  if (/©|copyright/i.test(text)) return { filtered: true, reason: 'copyright_noise', text: text };
  if (/^[\d\s.,;:!?\-()]+$/.test(text)) return { filtered: true, reason: 'numeric_noise', text: text };
  if (text === lastTranscription) return { filtered: true, reason: 'duplicate', text: text };

  return { filtered: false, reason: null, text: text };
}

module.exports = { transcribeAudio, filterNoise };
