/**
 * LLM — OpenAI GPT direct integration
 */

async function generateResponse(systemPrompt, messages, model, temperature) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const chatMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: chatMessages,
      temperature: temperature || 0.7,
      max_tokens: 300
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('OpenAI error: ' + err);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

module.exports = { generateResponse };
