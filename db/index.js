/**
 * db/index.js — Sandbox stub
 *
 * The sandbox does not use a DB for voice sessions (config comes from client).
 * This stub provides no-op query/getOne so the ported production voice pipeline
 * can import from '../db/index.js' without modification.
 */

async function query() {
  return { rows: [] };
}

async function getOne() {
  return null;
}

module.exports = { query, getOne };
