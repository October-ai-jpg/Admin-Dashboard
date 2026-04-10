/**
 * voice/llm.js — GPT streaming with function calling
 *
 * Ported 1:1 from production (platform/voice/llm.js).
 *
 * Streams GPT responses and emits text chunks + tool calls.
 */

const { buildSystemPrompt, buildTools } = require("../services/agentPersona");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GPT_MODEL = "gpt-5.4-mini";
const GPT_TIMEOUT_MS = 12000;
const MAX_GPT_CALLS = 50;

/**
 * Build the messages array for GPT from session state.
 */
function buildMessages(session) {
  // Trim compiled context to reduce token count for faster GPT responses
  let ctx = session.compiledContext || "";
  if (ctx.length > 4000) ctx = ctx.substring(0, 4000) + "\n[...]";

  const elapsedMinutes = Math.round((Date.now() - (session.startedAt || Date.now())) / 60000);

  const systemPrompt = buildSystemPrompt({
    vertical: session.vertical,
    propertyName: session.propertyName,
    places: session.places,
    compiledContext: ctx,
    language: session.language,
    dateTime: new Date().toLocaleString("en-GB", { timeZone: "Europe/Copenhagen" }),
    conversationState: session.state,
    userProfile: session.userProfile,
    navigatedRooms: session.navigatedRooms || [],
    lastRecommendedRoom: session.lastRecommendedRoom || null,
    turnCount: session.turnCount || 0,
    elapsedMinutes,
    roomMappings: session.roomMappings || {},
    propertyDetails: session.propertyDetails || null
  });

  // Last 16 turns for better conversational context
  const history = session.conversationHistory.slice(-16).map(turn => ({
    role: turn.role === "user" ? "user" : "assistant",
    content: turn.content
  }));

  return [{ role: "system", content: systemPrompt }, ...history];
}

/**
 * Buffer-based tool call leak suppressor.
 *
 * Previous approach (pattern-match on accumulated text) was too slow —
 * by the time "[update" was detected, earlier chunks already reached TTS.
 *
 * New approach: BUFFER suspicious content before it reaches TTS.
 * - Normal text: emitted immediately (zero latency impact)
 * - '[' detected: buffer from '[', wait for next chunk to confirm
 * - Underscore tool prefix (navigate_, trigger_, update_): buffer and check
 * - Trailing "navigate"/"trigger"/"update" at chunk end: hold one chunk
 * - JSON '{' at start: suppress immediately
 *
 * Once a leak is confirmed, 'poisoned' flag suppresses all remaining text.
 */
const TOOL_NAME_PATTERN = /\b(navigate_to_room|trigger_conversion|update_user_profile|update_conversation_state|set_view_mode)\b/;
const TOOL_PARTIAL_PATTERN = /\b(navigate_|trigger_|update_|set_view)/;
const TOOL_BRACKET_PATTERN = /\[\s*(navigate|trigger|update|set_view|functions)/;

function createLeakSuppressor() {
  let poisoned = false;
  let buffer = "";

  return {
    /**
     * Process a content chunk. Returns text safe to emit (may be empty).
     * Buffers suspicious content until the next chunk confirms it's safe.
     */
    process(content) {
      if (poisoned) return "";

      const text = buffer + content;
      buffer = "";

      // 1. JSON leak — opening brace
      if (text.trim().startsWith('{')) {
        poisoned = true;
        console.warn("[LLM] JSON leak suppressed:", text.substring(0, 80));
        return "";
      }

      // 2. Full tool name — immediate poison, preserve text before it
      const fullMatch = TOOL_NAME_PATTERN.exec(text);
      if (fullMatch) {
        poisoned = true;
        console.warn("[LLM] Tool name leak suppressed:", text.substring(0, 100));
        return text.substring(0, fullMatch.index).trimEnd();
      }

      // 3. Partial tool name (underscore-joined prefix like navigate_, update_)
      const partialMatch = TOOL_PARTIAL_PATTERN.exec(text);
      if (partialMatch) {
        buffer = text.substring(partialMatch.index);
        const safe = text.substring(0, partialMatch.index);
        if (buffer.length > 40) {
          poisoned = true;
          console.warn("[LLM] Long partial tool leak suppressed:", buffer.substring(0, 80));
          return safe.trimEnd();
        }
        return safe;
      }

      // 4. Bracket — buffer from '[' to check for tool call
      const bracketIdx = text.lastIndexOf('[');
      if (bracketIdx >= 0) {
        const afterBracket = text.substring(bracketIdx);
        if (TOOL_BRACKET_PATTERN.test(afterBracket)) {
          poisoned = true;
          console.warn("[LLM] Bracket tool leak suppressed:", afterBracket.substring(0, 80));
          return text.substring(0, bracketIdx).trimEnd();
        }
        // Enough chars after '[' to confirm safe (longest prefix "functions" = 9)
        if (afterBracket.length > 12) {
          return text;
        }
        buffer = afterBracket;
        return text.substring(0, bracketIdx);
      }

      // 5. Trailing word that could start a tool name — hold one chunk
      const trailingMatch = text.match(/(navigate|trigger|update)_?$/);
      if (trailingMatch) {
        buffer = text.substring(trailingMatch.index);
        return text.substring(0, trailingMatch.index);
      }

      // 6. Normal text — emit immediately
      return text;
    },

    /**
     * Flush remaining buffer at end of stream.
     */
    flush() {
      if (poisoned) return "";
      const remaining = buffer;
      buffer = "";
      if (!remaining) return "";
      if (TOOL_NAME_PATTERN.test(remaining) || TOOL_PARTIAL_PATTERN.test(remaining)) {
        console.warn("[LLM] Tool leak caught in flush:", remaining.substring(0, 80));
        return "";
      }
      if (TOOL_BRACKET_PATTERN.test(remaining)) {
        console.warn("[LLM] Bracket leak caught in flush:", remaining.substring(0, 80));
        return "";
      }
      // Lone bracket — likely truncated tool call
      if (remaining.includes('[') && remaining.length < 15) return "";
      return remaining;
    },

    isPoisoned() { return poisoned; }
  };
}

/**
 * Stream GPT response.
 *
 * @param {object} session - Voice session
 * @param {string} userMessage - The user's transcribed message
 * @param {(chunk: string) => void} onTextChunk - Called for each text delta
 * @param {(toolName: string, args: object) => void} onToolCall - Called for each complete tool call
 * @param {() => void} onDone - Called when streaming is complete
 */
async function streamGPT(session, userMessage, onTextChunk, onToolCall, onDone, options = {}) {
  if (!OPENAI_API_KEY) {
    throw new Error("LLM_NO_API_KEY");
  }

  if (session.gptCallCount >= MAX_GPT_CALLS) {
    throw new Error("LLM_SESSION_LIMIT");
  }

  // Add user message to history
  session.conversationHistory.push({ role: "user", content: userMessage });

  session.gptCallCount++;
  const messages = buildMessages(session);
  const tools = buildTools(session);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GPT_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: GPT_MODEL,
        stream: true,
        messages,
        max_completion_tokens: options.maxTokens || 200,
        temperature: 0.7,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error("LLM_API_ERROR:" + response.status + " " + errBody.substring(0, 200));
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = "";
    const toolCallBuffer = {}; // index → { name, args }
    let sseBuffer = "";
    const leakSuppressor = createLeakSuppressor();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      // Keep last potentially incomplete line
      sseBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.substring(6).trim();
        if (jsonStr === "[DONE]") continue;

        try {
          const chunk = JSON.parse(jsonStr);
          const delta = chunk.choices?.[0]?.delta;
          const finishReason = chunk.choices?.[0]?.finish_reason;
          if (finishReason === "length") {
            console.warn("[LLM] GPT stopped due to max_completion_tokens — response may be truncated");
          }
          if (!delta) continue;

          // Content tokens — run through buffer-based leak suppressor
          if (delta.content) {
            const safeText = leakSuppressor.process(delta.content);
            if (safeText) {
              fullResponse += safeText;
              onTextChunk(safeText);
            }
          }

          // Tool call tokens
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallBuffer[idx]) toolCallBuffer[idx] = { name: "", args: "" };
              if (tc.function?.name) toolCallBuffer[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCallBuffer[idx].args += tc.function.arguments;
            }
          }
        } catch (e) {
          // Skip malformed SSE chunks
        }
      }
    }

    // Flush any remaining buffered text from leak suppressor
    const remaining = leakSuppressor.flush();
    if (remaining) {
      fullResponse += remaining;
      onTextChunk(remaining);
    }

    // Process completed tool calls
    for (const idx in toolCallBuffer) {
      const tc = toolCallBuffer[idx];
      if (tc.name) {
        try {
          const args = JSON.parse(tc.args || "{}");
          onToolCall(tc.name, args);
        } catch (e) {
          console.warn("[LLM] Tool call parse error:", tc.name, e.message);
        }
      }
    }

    // Add assistant response to history
    if (fullResponse) {
      session.conversationHistory.push({ role: "assistant", content: fullResponse });
    } else if (Object.keys(toolCallBuffer).length > 0) {
      const toolNames = Object.values(toolCallBuffer).map(t => t.name).filter(Boolean).join(", ");
      session.conversationHistory.push({ role: "assistant", content: `[tool: ${toolNames}]` });
    }

    // Trim history to 20 turns
    while (session.conversationHistory.length > 20) {
      session.conversationHistory.shift();
    }

    onDone();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("LLM_TIMEOUT");
    }
    throw err;
  }
}

module.exports = { streamGPT, createLeakSuppressor };
