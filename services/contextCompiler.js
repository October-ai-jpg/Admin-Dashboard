/**
 * Context Compiler — compiles raw property data into a structured,
 * compressed system prompt block for the voice agent.
 *
 * Runs offline (on tenant save / property data update), not during
 * voice sessions. Uses GPT-4o-mini for the compilation step.
 *
 * Ported 1:1 from production (platform/services/contextCompiler.js).
 * Excludes compileAndStore() which depends on a database.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Universal compilation prompt — works for any business type and language
function buildCompilationPrompt(propertyName) {
  return `You are preparing a knowledge briefing for an AI employee at a business called ${propertyName || "this business"}.
This employee will have intelligent voice conversations with visitors and must be able to make relevant, personalised recommendations based on what visitors tell them.

From the raw data below, extract and structure only what is actually present. Skip any section where you have no real data. Never write "not specified" or "N/A" — just omit the section.

Output MUST be under 2000 tokens. Write in compact fact lines, not prose. Preserve exact numbers, prices, dates, names, URLs, phone numbers.

IMPORTANT: If the data contains both manually provided information and scraped information, the manually provided information is authoritative and takes priority over scraped data in case of any conflicts.

Respond in English regardless of the language of the raw data.

Use exactly these section headers (skip any section with no data):

BUSINESS OVERVIEW
What this business is, what it offers, and who it is for. (2-3 lines)

SPACES AND OPTIONS
For each room, space, unit, product, or option:
- Name
- Capacity or size if relevant
- Key features
- Best suited for: [describe the visitor type or need this fits best]
- Price if available

VISITOR MATCHING
Based on the options above, create matching guidance:
- Visitors with [specific need or situation] → [option name] because [specific reason]
Add as many relevant patterns as the data supports.

PRACTICAL INFORMATION
Hours, booking or purchase process, pricing structure, parking, accessibility, policies, contact.

CONVERSION
What is the primary desired action for this business?
What is the process or URL?
When is the right moment to offer it in a conversation?`;
}

/**
 * Compile raw property data into a structured context block.
 * @param {string} propertyData - Raw scraped or pasted property text
 * @param {string} propertyName - Name of the property
 * @param {string} vertical - Property vertical (hotel, venue, etc.)
 * @param {string} bookingUrl - Booking/conversion URL
 * @param {object} roomMappings - Room mappings { id: { label, sweepId } }
 * @returns {Promise<string|null>} Compiled context block or null on failure
 */
async function compileContext(propertyData, propertyName, vertical, bookingUrl, roomMappings) {
  if (!propertyData || propertyData.length < 50) {
    return null;
  }

  if (!OPENAI_API_KEY) {
    console.warn("[ContextCompiler] No OPENAI_API_KEY — cannot compile");
    return null;
  }

  // Truncate input to fit in model context
  var inputData = propertyData;
  if (inputData.length > 60000) {
    inputData = inputData.substring(0, 60000) + "\n[Truncated]";
  }

  // Include room mappings as additional context
  var roomContext = "";
  if (roomMappings && typeof roomMappings === "object") {
    var roomNames = Object.entries(roomMappings)
      .map(function(e) { return e[1]?.label || e[0]; })
      .filter(Boolean);
    if (roomNames.length > 0) {
      roomContext = "\n\nAVAILABLE 3D TOUR SPACES: " + roomNames.join(", ");
    }
  }

  var userMessage = `Compile the following property data into a structured voice agent knowledge block.

Property name: ${propertyName || "Unknown"}
Vertical: ${vertical || "other"}
Booking URL: ${bookingUrl || "none"}
${roomContext}

RAW PROPERTY DATA:
${inputData}`;

  var controller = new AbortController();
  var timeout = setTimeout(function() { controller.abort(); }, 30000);

  try {
    var startTime = Date.now();
    var response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: buildCompilationPrompt(propertyName) },
          { role: "user", content: userMessage }
        ],
        max_tokens: 2500,
        temperature: 0.3
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      var errText = await response.text();
      console.error("[ContextCompiler] API error:", response.status, errText.substring(0, 200));
      return null;
    }

    var data = await response.json();
    var compiled = data.choices?.[0]?.message?.content || null;
    var tokens = data.usage ? (data.usage.prompt_tokens + data.usage.completion_tokens) : 0;

    if (!compiled || compiled.length < 100) {
      console.warn("[ContextCompiler] Output too short or empty");
      return null;
    }

    console.log("[ContextCompiler] Compiled " + propertyData.length + " chars → " + compiled.length + " chars (" + tokens + " tokens) in " + (Date.now() - startTime) + "ms");
    return compiled;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === "AbortError") {
      console.error("[ContextCompiler] Timed out after 30s");
    } else {
      console.error("[ContextCompiler] Error:", e.message);
    }
    return null;
  }
}

module.exports = { compileContext, buildCompilationPrompt };
