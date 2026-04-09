/**
 * LLM — OpenAI GPT with tool calling
 * Supports navigate_to_room, trigger_conversion, update_user_profile
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'navigate_to_room',
      description: 'Navigate the 3D virtual tour to show a specific room or space to the visitor. Use when the visitor asks to see a room or when recommending a space.',
      parameters: {
        type: 'object',
        properties: {
          room_name: {
            type: 'string',
            description: 'The name of the room or space to navigate to'
          }
        },
        required: ['room_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'trigger_conversion',
      description: 'Open the booking or conversion page for the visitor when they express clear interest in making a reservation, purchase, or taking the desired action.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Brief reason for triggering conversion'
          }
        },
        required: ['reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_user_profile',
      description: 'Update information learned about the visitor during the conversation.',
      parameters: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            description: 'The field to update (e.g. name, check_in_date, party_size, interests, budget, purpose)'
          },
          value: {
            type: 'string',
            description: 'The value to set'
          }
        },
        required: ['field', 'value']
      }
    }
  }
];

async function generateResponse(systemPrompt, messages, model, temperature, roomMappings) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const chatMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  // Add available room names to tool description if mappings exist
  var tools = JSON.parse(JSON.stringify(TOOLS));
  if (roomMappings && typeof roomMappings === 'object' && Object.keys(roomMappings).length > 0) {
    var roomNames = Object.entries(roomMappings).map(function(e) {
      var val = e[1];
      return (typeof val === 'string') ? val : (val.label || e[0]);
    }).filter(Boolean);
    if (roomNames.length > 0) {
      tools[0].function.parameters.properties.room_name.description =
        'The name of the room to navigate to. Available rooms: ' + roomNames.join(', ');
    }
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model || 'gpt-5.4-mini',
      messages: chatMessages,
      temperature: temperature || 0.7,
      max_tokens: 300,
      tools: tools,
      tool_choice: 'auto'
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('OpenAI error: ' + err);
  }

  const data = await response.json();
  const choice = data.choices?.[0];

  return {
    text: choice?.message?.content || '',
    toolCalls: choice?.message?.tool_calls || [],
    message: choice?.message || { role: 'assistant', content: '' },
    usage: data.usage
  };
}

module.exports = { generateResponse };
