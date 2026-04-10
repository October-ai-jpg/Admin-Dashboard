/**
 * voice/session.js — Session factory and conversation state machine
 *
 * Ported 1:1 from production (platform/voice/session.js).
 */

const { randomUUID } = require("crypto");

const CONVERSATION_STATES = {
  GREETING: "greeting",
  QUALIFYING: "qualifying",
  RECOMMENDING: "recommending",
  CLOSING: "closing",
  CONVERTED: "converted",
  ENDED: "ended"
};

const VALID_TRANSITIONS = {
  [CONVERSATION_STATES.GREETING]:      [CONVERSATION_STATES.QUALIFYING, CONVERSATION_STATES.RECOMMENDING, CONVERSATION_STATES.CLOSING],
  [CONVERSATION_STATES.QUALIFYING]:    [CONVERSATION_STATES.RECOMMENDING, CONVERSATION_STATES.CLOSING],
  [CONVERSATION_STATES.RECOMMENDING]:  [CONVERSATION_STATES.CLOSING, CONVERSATION_STATES.QUALIFYING],
  [CONVERSATION_STATES.CLOSING]:       [CONVERSATION_STATES.CONVERTED, CONVERSATION_STATES.RECOMMENDING],
  [CONVERSATION_STATES.CONVERTED]:     [CONVERSATION_STATES.ENDED],
  [CONVERSATION_STATES.ENDED]:         []
};

/**
 * Attempt a state transition. Returns true if valid, false if rejected.
 */
function transitionState(session, newState) {
  const allowed = VALID_TRANSITIONS[session.state];
  if (!allowed || !allowed.includes(newState)) {
    console.warn(`[Session] Invalid state transition: ${session.state} → ${newState}`);
    return false;
  }
  session.state = newState;
  return true;
}

/**
 * Create a new voice session.
 *
 * @param {string} tenantId
 * @param {object} config - { language, propertyName, vertical, compiledContext, places, conversionUrl }
 */
function createSession(tenantId, config = {}) {
  return {
    id: randomUUID(),
    tenantId,
    conversationId: null,

    // Conversation state machine
    state: CONVERSATION_STATES.GREETING,
    turnCount: 0,
    gptCallCount: 0,

    // Collected user info (populated during qualifying)
    userProfile: {
      guestCount: null,
      checkInDate: null,
      checkOutDate: null,
      purpose: null,
      budget: null,
      preferences: [],
      name: null
    },

    // Room tracking
    recommendedRooms: [],
    lastRecommendedRoom: null,
    navigatedRooms: [],

    // Conversation history (max 20 turns)
    conversationHistory: [],

    // Audio state
    isProcessing: false,

    // TTS cancel function (for interrupt)
    cancelTTS: null,
    ttsEndedAt: null,

    // Silence follow-up limiter (max 1 per session)
    silenceFollowUpCount: 0,

    // Unclear-audio tracking (too short / empty STT / low confidence / too_short / hallucination)
    unclearAudioCount: 0,
    unclearPopupSent: false,

    // Misc
    language: config.language || "en",
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    lastTranscription: "",

    // Usage tracking (active TTS time only)
    ttsSeconds: 0,
    reportedTtsSeconds: 0,
    totalAudioSeconds: 0,
    userId: null,
    usageRecordId: null,
    usageInterval: null,
    contextTokens: 0,

    // Conversion tracking
    conversionSignals: [],
    conversionStage: "browsing",
    toolsUsed: {},

    // Config from tenant
    propertyName: config.propertyName || "",
    vertical: config.vertical || "other",
    compiledContext: config.compiledContext || "",
    places: config.places || {},
    conversionUrl: config.conversionUrl || "",
    roomMappings: config.roomMappings || {},
    propertyDetails: config.propertyDetails || null
  };
}

module.exports = { createSession, transitionState, CONVERSATION_STATES };
