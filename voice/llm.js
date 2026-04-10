/**
 * LLM — OpenAI GPT Streaming with Tool Calling + Leak Suppressor
 * Pipeline version: 3.0
 *
 * v3 changes:
 *  - buildTools removed (now in services/agentPersona.js)
 *  - Model/temperature hardcoded to production values
 *  - Tool definitions come from agentPersona.buildTools()
 *  - SSE streaming with buffer-based leak suppressor
 *  - AbortController timeout (12s)
 */

var GPT_TIMEOUT_MS = 12000;


/* ═══════════════════════════════════════════════════════════════
 * Tool Call Leak Suppressor (matches production llm.js)
 *
 * Buffers suspicious content before it reaches TTS.
 * Normal text flows immediately (zero latency impact).
 * ═══════════════════════════════════════════════════════════════ */

var TOOL_NAME_PATTERN = /\b(navigate_to_room|trigger_conversion|update_user_profile|update_conversation_state|set_view_mode)\b/;
var TOOL_PARTIAL_PATTERN = /\b(navigate_|trigger_|update_|set_view)/;
var TOOL_BRACKET_PATTERN = /\[\s*(navigate|trigger|update|set_view|functions)/;

function createLeakSuppressor() {
  var poisoned = false;
  var buffer = '';

  return {
    process: function (content) {
      if (poisoned) return '';

      var text = buffer + content;
      buffer = '';

      // 1. JSON leak
      if (text.trim().startsWith('{')) {
        poisoned = true;
        console.warn('[LLM] JSON leak suppressed:', text.substring(0, 80));
        return '';
      }

      // 2. Full tool name
      var fullMatch = TOOL_NAME_PATTERN.exec(text);
      if (fullMatch) {
        poisoned = true;
        console.warn('[LLM] Tool name leak suppressed:', text.substring(0, 100));
        return text.substring(0, fullMatch.index).trimEnd();
      }

      // 3. Partial tool name
      var partialMatch = TOOL_PARTIAL_PATTERN.exec(text);
      if (partialMatch) {
        buffer = text.substring(partialMatch.index);
        var safe = text.substring(0, partialMatch.index);
        if (buffer.length > 40) {
          poisoned = true;
          console.warn('[LLM] Long partial tool leak suppressed:', buffer.substring(0, 80));
          return safe.trimEnd();
        }
        return safe;
      }

      // 4. Bracket
      var bracketIdx = text.lastIndexOf('[');
      if (bracketIdx >= 0) {
        var afterBracket = text.substring(bracketIdx);
        if (TOOL_BRACKET_PATTERN.test(afterBracket)) {
          poisoned = true;
          console.warn('[LLM] Bracket tool leak suppressed:', afterBracket.substring(0, 80));
          return text.substring(0, bracketIdx).trimEnd();
        }
        if (afterBracket.length > 12) return text;
        buffer = afterBracket;
        return text.substring(0, bracketIdx);
      }

      // 5. Trailing word
      var trailingMatch = text.match(/(navigate|trigger|update)_?$/);
      if (trailingMatch) {
        buffer = text.substring(trailingMatch.index);
        return text.substring(0, trailingMatch.index);
      }

      // 6. Normal text
      return text;
    },

    flush: function () {
      if (poisoned) return '';
      var remaining = buffer;
      buffer = '';
      if (!remaining) return '';
      if (TOOL_NAME_PATTERN.test(remaining) || TOOL_PARTIAL_PATTERN.test(remaining)) {
        console.warn('[LLM] Tool leak caught in flush:', remaining.substring(0, 80));
        return '';
      }
      if (TOOL_BRACKET_PATTERN.test(remaining)) return '';
      if (remaining.includes('[') && remaining.length < 15) return '';
      return remaining;
    },

    isPoisoned: function () { return poisoned; }
  };
}


/* ═══════════════════════════════════════════════════════════════
 * Streaming GPT — SSE with tool call accumulation
 * ═══════════════════════════════════════════════════════════════ */

/**
 * Stream a GPT response via SSE.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {Array}  opts.messages - conversation history [{ role, content }]
 * @param {string} opts.model
 * @param {number} opts.temperature
 * @param {Array}  opts.tools - OpenAI tool definitions
 * @param {number} [opts.maxTokens=200]
 * @param {(chunk: string) => void} onTextChunk
 * @param {(name: string, args: object) => void} onToolCall
 * @param {(fullText: string) => void} onDone
 */
async function streamGPT(opts, onTextChunk, onToolCall, onDone) {
  var apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  var chatMessages = [{ role: 'system', content: opts.systemPrompt }].concat(opts.messages || []);
  var model = opts.model || 'gpt-5.4-mini';
  var temperature = opts.temperature != null ? opts.temperature : 0.7;
  var tools = opts.tools && opts.tools.length > 0 ? opts.tools : undefined;
  var maxTokens = opts.maxTokens || 200;

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, GPT_TIMEOUT_MS);

  try {
    var body = {
      model: model,
      stream: true,
      messages: chatMessages,
      max_completion_tokens: maxTokens,
      temperature: temperature
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    var response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      var errBody = await response.text().catch(function () { return ''; });
      throw new Error('LLM_API_ERROR:' + response.status + ' ' + errBody.substring(0, 200));
    }

    // Parse SSE stream
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var fullResponse = '';
    var toolCallBuffer = {};
    var sseBuffer = '';
    var leakSuppressor = createLeakSuppressor();

    while (true) {
      var readResult = await reader.read();
      if (readResult.done) break;

      sseBuffer += decoder.decode(readResult.value, { stream: true });
      var lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line.startsWith('data: ')) continue;
        var jsonStr = line.substring(6).trim();
        if (jsonStr === '[DONE]') continue;

        try {
          var chunk = JSON.parse(jsonStr);
          var delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          var finishReason = chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason;
          if (finishReason === 'length') {
            console.warn('[LLM] GPT stopped due to max_completion_tokens');
          }
          if (!delta) continue;

          // Content tokens — through leak suppressor
          if (delta.content) {
            var safeText = leakSuppressor.process(delta.content);
            if (safeText) {
              fullResponse += safeText;
              onTextChunk(safeText);
            }
          }

          // Tool call tokens
          if (delta.tool_calls) {
            for (var j = 0; j < delta.tool_calls.length; j++) {
              var tc = delta.tool_calls[j];
              var idx = tc.index != null ? tc.index : 0;
              if (!toolCallBuffer[idx]) toolCallBuffer[idx] = { name: '', args: '' };
              if (tc.function && tc.function.name) toolCallBuffer[idx].name = tc.function.name;
              if (tc.function && tc.function.arguments) toolCallBuffer[idx].args += tc.function.arguments;
            }
          }
        } catch (e) {
          // Skip malformed SSE chunks
        }
      }
    }

    // Flush remaining buffered text
    var remaining = leakSuppressor.flush();
    if (remaining) {
      fullResponse += remaining;
      onTextChunk(remaining);
    }

    // Process completed tool calls
    var toolKeys = Object.keys(toolCallBuffer);
    for (var k = 0; k < toolKeys.length; k++) {
      var tc2 = toolCallBuffer[toolKeys[k]];
      if (tc2.name) {
        try {
          var args = JSON.parse(tc2.args || '{}');
          onToolCall(tc2.name, args);
        } catch (e) {
          console.warn('[LLM] Tool call parse error:', tc2.name, e.message);
        }
      }
    }

    onDone(fullResponse);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('LLM_TIMEOUT');
    throw err;
  }
}

module.exports = { streamGPT, createLeakSuppressor };
