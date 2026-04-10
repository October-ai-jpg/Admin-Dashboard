/**
 * voice/stt.js — Deepgram Nova-3 STT
 *
 * Ported 1:1 from production (platform/voice/stt.js).
 *
 * Transcribes PCM16 audio buffers using Deepgram's Nova-3.
 * No fallback — if Deepgram fails, the error propagates to the caller.
 */

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_STT_URL = "https://api.deepgram.com/v1/listen";
const STT_TIMEOUT_MS = 8000;

/**
 * Convert PCM16 buffer (24kHz mono 16-bit) to WAV format.
 */
function pcm16ToWav(pcmBuffer) {
  const sampleRate = 24000;
  const channels = 1;
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);       // PCM format chunk size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Transcribe a PCM16 audio buffer via Deepgram Nova-3.
 *
 * @param {Buffer} pcm16Buffer - Raw PCM16 24kHz mono audio
 * @param {string} language - ISO language code (default "en")
 * @returns {{ text: string, language: string, confidence: number, words: Array }}
 */
async function transcribeAudio(pcm16Buffer, language = "en") {
  if (!DEEPGRAM_API_KEY) {
    throw new Error("STT_NO_API_KEY");
  }

  // Minimum ~500ms of audio at 24kHz 16-bit mono = 24000 bytes
  // Rejects echo fragments and breath sounds
  if (pcm16Buffer.length < 24000) {
    throw new Error("STT_AUDIO_TOO_SHORT");
  }

  const wavBuffer = pcm16ToWav(pcm16Buffer);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);

  try {
    const url = `${DEEPGRAM_STT_URL}?model=nova-3&language=${language}&smart_format=true`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Token " + DEEPGRAM_API_KEY,
        "Content-Type": "audio/wav"
      },
      body: wavBuffer,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[STT] Deepgram error:", res.status, errBody.substring(0, 200));
      throw new Error("STT_DEEPGRAM_ERROR:" + res.status);
    }

    const result = await res.json();
    const alt = result.results?.channels?.[0]?.alternatives?.[0];
    const text = (alt?.transcript || "").trim();
    const confidence = alt?.confidence ?? 1.0;
    const words = alt?.words || [];

    return { text, language, confidence, words };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("STT_TIMEOUT");
    }
    throw err;
  }
}

/**
 * Filter noise and non-speech transcriptions.
 *
 * Returns { filtered: boolean, reason: string|null, text: string }
 */

const ACK_PATTERN = /^(yes|no|sure|okay|ok|thanks|thank you|great|perfect|sounds good|alright|got it|right|exactly|yeah|yep|nope|fine|good|nice|cool|awesome|wonderful|lovely|hi|hello|hey|hi there|hey there|good morning|good afternoon|good evening|bye|goodbye|see you|take care|ciao|hej|hola|bonjour|ja|nej|tak|hej hej|godmorgen|godaften)\.?$/i;

// Common Whisper/STT hallucinations on short/silent audio
const HALLUCINATION_PATTERN = /^(you|to|the|a|an|i|it|is|and|that|this|but|for|with|so|do|if|my|or|we|at|in|on|be|go|of|up|by|as|us|am|oh|ah|uh|um|hm|hmm|ha|eh|er|mhm)\.?$/i;

// Minimum confidence threshold — below this, the transcription is likely noise/ambient
const MIN_CONFIDENCE = 0.65;

// Patterns that indicate ambient audio (TV, music, other speakers, background noise)
const AMBIENT_NOISE_PATTERNS = [
  /\b\d{4}\b.*\b\d{4}\b/,                    // Multiple years (TV credits, listicles)
  /\b(chapter|verse|psalm|genesis|exodus)\b/i, // Religious text from TV/radio
  /\b(subscribe|like and|click|notification|comment below)\b/i, // YouTube/video playing
  /♪|🎵|🎶|la la la|do do do|na na na/i,      // Music
  /\b(ladies and gentlemen|stay tuned|coming up next|commercial break)\b/i, // TV broadcast
  /\b(www\.|\.com|\.org|\.net|http)\b/i,       // URLs spoken from TV/radio
  /\b(terms and conditions|privacy policy|all rights reserved)\b/i, // Legal disclaimers
];

function filterNoise(rawTranscript, lastTranscription = "", confidence = 1.0) {
  const text = (rawTranscript || "").trim();

  if (!text) {
    return { filtered: true, reason: "empty", text };
  }

  // Low confidence — likely ambient noise, echo, or music
  if (confidence < MIN_CONFIDENCE) {
    return { filtered: true, reason: "low_confidence", text };
  }

  // Filter STT hallucinations on echo/noise (single common words)
  if (HALLUCINATION_PATTERN.test(text)) {
    return { filtered: true, reason: "hallucination", text };
  }

  // ACK bypass — short acknowledgements pass through unfiltered
  if (ACK_PATTERN.test(text)) {
    return { filtered: false, reason: null, text };
  }

  // Word count check (min 2 words for non-ACK)
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < 2) {
    return { filtered: true, reason: "too_short", text };
  }

  // Ambient noise patterns (TV, music, other audio sources)
  for (const pattern of AMBIENT_NOISE_PATTERNS) {
    if (pattern.test(text)) {
      return { filtered: true, reason: "ambient_noise", text };
    }
  }

  // Very long transcripts with low-medium confidence are likely background TV/radio
  // Real user speech in a conversation is rarely > 40 words in one segment
  if (wordCount > 40 && confidence < 0.85) {
    return { filtered: true, reason: "long_ambient", text };
  }

  // URL/copyright noise — only filter actual URLs, not words containing TLDs
  if (/^https?:\/\//i.test(text) || /^www\./i.test(text)) {
    return { filtered: true, reason: "url_noise", text };
  }
  if (/©|copyright/i.test(text)) {
    return { filtered: true, reason: "copyright_noise", text };
  }

  // Pure numbers/punctuation
  if (/^[\d\s.,;:!?\-()]+$/.test(text)) {
    return { filtered: true, reason: "numeric_noise", text };
  }

  // Duplicate check
  if (text === lastTranscription) {
    return { filtered: true, reason: "duplicate", text };
  }

  return { filtered: false, reason: null, text };
}

module.exports = { transcribeAudio, filterNoise };
