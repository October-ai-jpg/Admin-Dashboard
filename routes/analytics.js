/**
 * routes/analytics.js — Sandbox stub
 *
 * The sandbox does not persist analytics. This stub provides no-op versions
 * of the analytics functions so the ported production voice pipeline can
 * import from '../routes/analytics.js' without modification.
 */

async function startConversation() {
  return null;
}

async function endConversation() {
  return null;
}

async function logMessage() {
  return null;
}

async function logConversion() {
  return null;
}

module.exports = { startConversation, endConversation, logMessage, logConversion };
