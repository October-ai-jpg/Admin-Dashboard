/**
 * TTS — Cartesia Flash direct integration
 */

async function synthesizeSpeech(text) {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) throw new Error('CARTESIA_API_KEY not configured');

  const response = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Cartesia-Version': '2024-06-10',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model_id: 'sonic-flash',
      transcript: text,
      voice: {
        mode: 'id',
        id: 'a0e99841-438c-4a64-b679-ae501e7d6091' // Default warm voice
      },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: 24000
      }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Cartesia TTS error: ' + err);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Split into chunks for streaming (~100ms each at 24kHz 16-bit mono)
  const chunkSize = 24000 * 2 * 0.1; // 100ms of audio
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.slice(i, Math.min(i + chunkSize, buffer.length)));
  }

  return chunks;
}

module.exports = { synthesizeSpeech };
