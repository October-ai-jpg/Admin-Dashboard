/**
 * STT — Deepgram Nova-2 direct integration
 */

async function transcribeAudio(audioBuffer) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured');

  const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true', {
    method: 'POST',
    headers: {
      'Authorization': 'Token ' + apiKey,
      'Content-Type': 'audio/raw;encoding=linear16;sample_rate=16000;channels=1'
    },
    body: audioBuffer
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Deepgram STT error: ' + err);
  }

  const data = await response.json();
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  return transcript;
}

module.exports = { transcribeAudio };
