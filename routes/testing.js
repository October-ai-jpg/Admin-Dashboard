/**
 * routes/testing.js — Test session management & GPT evaluation
 *
 * Receives test session data from -october-ai via HTTP POST,
 * stores in PostgreSQL, runs GPT evaluation, and serves to the admin UI.
 */

const express = require('express');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'october-admin-2026';

module.exports = function(pool) {
  const router = express.Router();

  /* ── Helper: run DB migration on first load ── */
  let migrated = false;
  async function ensureTable() {
    if (migrated || !pool) return;
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS test_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          vertical TEXT,
          model TEXT,
          temperature DECIMAL,
          tenant_id TEXT,
          matterport_model_id TEXT,
          duration_seconds INT,
          message_count INT,
          transcript JSONB DEFAULT '[]',
          latency_log JSONB DEFAULT '[]',
          gpt_scores JSONB DEFAULT '{}',
          gpt_summary TEXT,
          gpt_flags JSONB DEFAULT '[]',
          gpt_biggest_problem TEXT,
          gpt_ready_for_customers BOOLEAN,
          gpt_ready_explanation TEXT,
          manual_note TEXT,
          manual_rating INT,
          manual_tags JSONB DEFAULT '[]',
          status TEXT DEFAULT 'review'
        );
        CREATE INDEX IF NOT EXISTS idx_test_sessions_vertical ON test_sessions(vertical);
        CREATE INDEX IF NOT EXISTS idx_test_sessions_status ON test_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_test_sessions_created ON test_sessions(created_at);
      `);
      migrated = true;
      console.log('  \u2713 test_sessions table ready');
    } catch(e) {
      console.warn('  \u26A0 test_sessions migration:', e.message);
      migrated = true; // Don't retry
    }
  }
  ensureTable();

  /* ────────────────────────────────────────────
     POST /api/test-sessions — receive from -october-ai
     Auth: x-admin-key header
     ──────────────────────────────────────────── */
  router.post('/', async (req, res) => {
    try {
      // Auth via x-admin-key (from -october-ai) OR x-admin-token (from dashboard UI)
      const key = req.headers['x-admin-key'] || req.headers['x-admin-token'] || req.query.token;
      if (key !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
      if (!pool) return res.status(500).json({ error: 'Database not configured' });

      await ensureTable();
      const b = req.body;
      const result = await pool.query(
        `INSERT INTO test_sessions
         (vertical, model, temperature, tenant_id, matterport_model_id,
          duration_seconds, message_count, transcript, latency_log, manual_note, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          b.vertical || null, b.model || null, b.temperature || null,
          b.tenant_id || null, b.matterport_model_id || null,
          b.duration_seconds || 0, b.message_count || 0,
          JSON.stringify(b.transcript || []),
          JSON.stringify(b.latency_log || []),
          b.manual_note || null,
          'review'
        ]
      );

      const sessionId = result.rows[0].id;

      // Auto-run GPT evaluation in background
      runGptEvaluation(sessionId).catch(function(e) {
        console.warn('[Testing] Background GPT eval error:', e.message);
      });

      res.json({ id: sessionId, ok: true });
    } catch (err) {
      console.error('[Testing] Create error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /* ────────────────────────────────────────────
     GET /api/test-sessions — list with filters
     ──────────────────────────────────────────── */
  router.get('/', async (req, res) => {
    try {
      if (!pool) return res.json([]);
      await ensureTable();
      const { vertical, status } = req.query;
      var sql = `SELECT id, created_at, vertical, model, temperature, duration_seconds,
                 message_count, gpt_scores, gpt_summary, gpt_flags, gpt_biggest_problem,
                 gpt_ready_for_customers, gpt_ready_explanation,
                 manual_note, manual_rating, manual_tags, status
                 FROM test_sessions WHERE 1=1`;
      var params = [];

      if (vertical) { params.push(vertical); sql += ' AND vertical = $' + params.length; }
      if (status)   { params.push(status);   sql += ' AND status = $' + params.length; }

      sql += ' ORDER BY created_at DESC LIMIT 200';
      var result = await pool.query(sql, params);
      res.json(result.rows);
    } catch (err) {
      console.error('[Testing] List error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /* ────────────────────────────────────────────
     GET /api/test-sessions/:id — full detail
     ──────────────────────────────────────────── */
  router.get('/:id', async (req, res) => {
    try {
      if (!pool) return res.status(404).json({ error: 'Not found' });
      await ensureTable();
      var result = await pool.query('SELECT * FROM test_sessions WHERE id = $1', [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
      res.json(result.rows[0]);
    } catch (err) {
      console.error('[Testing] Detail error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /* ────────────────────────────────────────────
     PUT /api/test-sessions/:id/note — save manual note
     ──────────────────────────────────────────── */
  router.put('/:id/note', async (req, res) => {
    try {
      if (!pool) return res.status(500).json({ error: 'DB not configured' });
      var { note, rating, tags, status } = req.body;
      var sets = []; var params = [];

      if (note !== undefined)   { params.push(note);                  sets.push('manual_note = $' + params.length); }
      if (rating !== undefined) { params.push(rating);                sets.push('manual_rating = $' + params.length); }
      if (tags !== undefined)   { params.push(JSON.stringify(tags));   sets.push('manual_tags = $' + params.length); }
      if (status !== undefined) { params.push(status);                sets.push('status = $' + params.length); }

      if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

      params.push(req.params.id);
      await pool.query('UPDATE test_sessions SET ' + sets.join(', ') + ' WHERE id = $' + params.length, params);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Testing] Note update error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /* ────────────────────────────────────────────
     POST /api/test-sessions/evaluate — GPT eval
     ──────────────────────────────────────────── */
  router.post('/evaluate', async (req, res) => {
    try {
      var { sessionId } = req.body;
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

      var evaluation = await runGptEvaluation(sessionId);
      res.json({ ok: true, evaluation: evaluation });
    } catch (err) {
      console.error('[Testing] Evaluate error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /* ────────────────────────────────────────────
     POST /api/test-sessions/report — fix report
     ──────────────────────────────────────────── */
  router.post('/report', async (req, res) => {
    try {
      if (!pool) return res.status(500).json({ error: 'DB not configured' });
      if (!OPENAI_API_KEY) return res.status(500).json({ error: 'No OPENAI_API_KEY' });

      var { vertical } = req.body;
      var sql = "SELECT * FROM test_sessions WHERE gpt_scores IS NOT NULL AND gpt_scores != '{}'::jsonb";
      var params = [];
      if (vertical && vertical !== 'all') {
        params.push(vertical);
        sql += ' AND vertical = $' + params.length;
      }
      sql += ' ORDER BY created_at DESC LIMIT 50';

      var result = await pool.query(sql, params);
      if (result.rows.length === 0) return res.status(400).json({ error: 'No evaluated sessions found' });

      var sessionsSummary = result.rows.map(function(s, i) {
        var scores = s.gpt_scores || {};
        var scoreLines = Object.keys(scores).map(function(k) {
          return '  ' + k + ': ' + (scores[k].score || 0) + '/10 - ' + (scores[k].explanation || '');
        }).join('\n');
        return 'SESSION ' + (i+1) + ':\nVertical: ' + (s.vertical||'?') + '\nDate: ' + s.created_at +
          '\nDuration: ' + s.duration_seconds + 's\nMessages: ' + s.message_count +
          '\nReady: ' + (s.gpt_ready_for_customers ? 'YES' : 'NO') +
          '\nBiggest problem: ' + (s.gpt_biggest_problem || 'N/A') +
          '\nManual note: ' + (s.manual_note || 'None') +
          '\nManual rating: ' + (s.manual_rating || 'Not rated') +
          '\nFlags: ' + JSON.stringify(s.gpt_flags || []) +
          '\nScores:\n' + scoreLines;
      }).join('\n\n---\n\n');

      var fixPrompt = 'You are analyzing test results for an AI voice agent that should act as a virtual employee in Matterport tours.\n\n' +
        'Based on ALL test sessions below, identify the most critical issues and provide specific actionable fix recommendations.\n\n' +
        'SESSIONS:\n' + sessionsSummary + '\n\n' +
        'Provide a detailed fix report:\n\n' +
        '1. OVERALL ASSESSMENT\n   Ready for real customers?\n   Single biggest blocker?\n\n' +
        '2. TOP 5 PROBLEMS\n   For each:\n   - Exact description\n   - Frequency (X/Y sessions)\n   - Severity: critical/major/minor\n   - File to change: agentPersona.js / pipeline.js / embed.js / stt.js / tts.js\n   - Specific recommendation\n\n' +
        '3. PATTERNS ACROSS VERTICALS\n   Which verticals perform better?\n   What differs?\n\n' +
        '4. TESTER NOTES ANALYSIS\n   Key themes GPT evaluation missed\n\n' +
        '5. PRIORITY FIX ORDER\n   Fix #1 first, then #2 etc\n\n' +
        '6. ESTIMATED IMPACT\n   Expected score improvement if top 3 issues are fixed';

      var gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are an expert AI voice agent analyst. Write detailed, actionable fix reports.' },
            { role: 'user', content: fixPrompt }
          ],
          temperature: 0.3
        })
      });
      if (!gptRes.ok) throw new Error('OpenAI API error: ' + (await gptRes.text()));
      var gptData = await gptRes.json();
      var report = (gptData.choices && gptData.choices[0] && gptData.choices[0].message && gptData.choices[0].message.content) || 'No report generated';

      res.json({ report: report, sessionsAnalyzed: result.rows.length, vertical: vertical || 'all', generatedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[Testing] Fix report error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /* ────────────────────────────────────────────
     DELETE /api/test-sessions/:id
     ──────────────────────────────────────────── */
  router.delete('/:id', async (req, res) => {
    try {
      if (!pool) return res.status(500).json({ error: 'DB not configured' });
      await pool.query('DELETE FROM test_sessions WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Testing] Delete error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /* ────────────────────────────────────────────
     GPT Evaluation Engine
     ──────────────────────────────────────────── */
  async function runGptEvaluation(sessionId) {
    if (!pool) throw new Error('Database not configured');
    if (!OPENAI_API_KEY) throw new Error('No OPENAI_API_KEY configured');

    var result = await pool.query('SELECT * FROM test_sessions WHERE id = $1', [sessionId]);
    if (result.rows.length === 0) throw new Error('Session not found');
    var session = result.rows[0];

    var transcript = session.transcript || [];
    var transcriptText = transcript.map(function(t) {
      var ts = t.timestamp ? '[' + t.timestamp + '] ' : '';
      return ts + (t.role || 'unknown') + ': ' + (t.text || t.content || '');
    }).join('\n');

    // Count guest vs agent messages for evaluation context
    var guestMessages = transcript.filter(function(t) { return t.role === 'user' || t.role === 'guest'; });
    var agentMessages = transcript.filter(function(t) { return t.role === 'assistant' || t.role === 'agent'; });
    var guestMessageCount = guestMessages.length;
    var agentMessageCount = agentMessages.length;

    var latencyLog = session.latency_log || [];
    /* 2026-04-29 — Scorer was blind to whether navigation/tools actually
       fired because we only sent total_ms. Now we surface per-turn
       navigation + tools_called arrays so the scorer can use them as
       ground truth (alongside the [ACTION: ...] markers that some
       transcripts carry). Without this the GPT scorer hallucinated
       "did not navigate" even when the latency_log showed
       navigation.triggered=true. */
    var latencyText = latencyLog.map(function(l, i) {
      var totalMs = (l.latency && l.latency.total_ms) || l.total_ms || '?';
      var nav = l.navigation || {};
      var navStr = nav.triggered
        ? 'navigated_to=' + (nav.room_label || '?') + (nav.sweep_id ? ' (sweep ' + nav.sweep_id + ')' : ' (NO sweepId)')
        : 'no_nav';
      var tools = (l.tools_called && l.tools_called.length > 0) ? 'tools=[' + l.tools_called.join(',') + ']' : 'tools=[]';
      var userTxt = (l.user_transcript || '').slice(0, 60);
      return 'Turn ' + (i+1) + ': "' + userTxt + '" → total=' + totalMs + 'ms | ' + navStr + ' | ' + tools;
    }).join('\n');

    var warningsArr = [];
    latencyLog.forEach(function(turn) {
      if (turn.warnings && turn.warnings.length > 0) {
        turn.warnings.forEach(function(w) { warningsArr.push(w.type + ': ' + (w.detail || w.message || '')); });
      }
    });
    var warningsText = warningsArr.length > 0 ? warningsArr.join('\n') : 'None';

    // Build critical context warnings for GPT
    var criticalWarnings = [];
    if (guestMessageCount === 0) {
      criticalWarnings.push('*** CRITICAL: ZERO GUEST MESSAGES — The guest never spoke. This session FAILED completely. ALL scores must be 0-1. ***');
    } else if (guestMessageCount <= 2) {
      criticalWarnings.push('*** WARNING: Only ' + guestMessageCount + ' guest message(s). Very minimal interaction. Maximum overall score: 3. ***');
    }
    if ((session.duration_seconds || 0) < 30 && guestMessageCount === 0) {
      criticalWarnings.push('*** CRITICAL: Session under 30 seconds with no guest interaction. Automatic 0-1 overall. ***');
    }
    if (session.manual_note) {
      criticalWarnings.push('TESTER NOTE: ' + session.manual_note);
    }
    var criticalWarningsText = criticalWarnings.length > 0 ? '\n\n' + criticalWarnings.join('\n') : '';

    var systemPrompt = 'You are an extremely strict expert evaluator of AI voice agents designed to act as virtual employees in Matterport 3D tours. Your job is to evaluate conversations critically and honestly. You are known for being harsh but fair.\n\n' +
      'GROUND TRUTH SOURCES (in priority order):\n' +
      '  1. LATENCY LOG \u2014 each turn shows what tools fired (tools=[...]) and whether navigation was triggered (navigated_to=ROOM or no_nav). Trust these over your reading of the transcript. If the log says navigated_to=Junior Suite, the agent navigated, even if the spoken text does not mention navigation.\n' +
      '  2. [ACTION: tool_name \u2192 arg] markers \u2014 may appear before some assistant lines (legacy format). Also ground truth.\n' +
      '  3. The transcript itself \u2014 use to judge HOW the agent spoke about the action.\n' +
      'When the latency log shows a tool fired but the spoken text does not acknowledge it, that is a NATURAL_TONE issue (agent failed to verbalise the action), NOT a NAVIGATION/CONVERSION_FOCUS issue. Do not double-penalise.\n\n' +
      'The agent should behave like a warm, knowledgeable human employee \u2014 not like a chatbot or assistant. It should:\n' +
      '- Ask one question at a time\n- React to what the visitor says before moving on\n- Navigate the tour naturally\n- Never use corporate filler phrases\n- Move conversations towards booking\n- Sound completely natural\n\n' +
      'CRITICAL SCORING RULES:\n' +
      '- If the transcript has 0 guest messages or only a greeting with no guest interaction: ALL scores MUST be 0-1, overall MUST be 0-1. There is nothing to evaluate \u2014 the session failed.\n' +
      '- If the transcript has only 1-2 guest messages: maximum overall score is 3. The agent barely had a chance to demonstrate anything.\n' +
      /* 2026-04-29 — was "If never navigated despite having room mappings: 0-2".
         That fired on Q&A-only sessions where the visitor never asked to be
         shown a room (e.g. a 3-turn pool feature question), producing false
         negatives. New rule only penalises missed navigation when the visitor
         clearly requested it. Same change for conversion. */
      '- NAVIGATION rule: only score navigation 0-2 if the visitor CLEARLY asked to be shown a room ("show me", "take me to", "can I see", "let me look at") AND the agent did NOT navigate. If navigation was never requested in this session, score navigation neutrally (5-7) based on whether navigation would have been a reasonable proactive offer.\n' +
      '- CONVERSION rule: only score conversion_focus 0-2 if the visitor showed clear booking intent ("I want to book", "let\'s do it", "I\'ll take it") AND the agent did NOT fire trigger_conversion. If the visitor was browsing/exploring/asking factual questions, score conversion_focus neutrally (5-7) \u2014 pushing conversion early on a browsing guest is a NEGATIVE behaviour, not a positive one.\n' +
      '- A score of 8+ means the agent performed EXCEPTIONALLY well on that criterion across multiple turns. This is rare.\n' +
      '- A score of 5 means MEDIOCRE, not "average". Most sessions should score 3-6.\n' +
      '- Be honest: would a real hotel/real estate company pay for this agent? If not, ready_for_customers MUST be false.\n' +
      '- Duration under 30 seconds with no real conversation = automatic 0-1 overall.\n' +
      '- Count the actual guest messages. If message_count is 0 or the transcript shows no real guest dialogue, this is a FAILED session.';

    var userPrompt = 'Evaluate this AI voice agent conversation.\n\n' +
      'VERTICAL: ' + (session.vertical || 'unknown') + '\n' +
      'MODEL: ' + (session.model || 'unknown') + '\n' +
      'TEMPERATURE: ' + (session.temperature || 'unknown') + '\n' +
      'DURATION: ' + (session.duration_seconds || 0) + ' seconds\n' +
      'TOTAL MESSAGE COUNT: ' + (session.message_count || 0) + '\n' +
      'GUEST MESSAGES: ' + guestMessageCount + '\n' +
      'AGENT MESSAGES: ' + agentMessageCount + '\n' +
      criticalWarningsText + '\n\n' +
      'LATENCY LOG:\n' + latencyText + '\n' +
      'AUTOMATIC WARNINGS:\n' + warningsText + '\n\n' +
      'FULL TRANSCRIPT:\n' + transcriptText + '\n\n' +
      'Score each criterion 0-10 with a specific explanation. Be strict. Pay close attention to the GUEST MESSAGES count above — if it is 0, this is a failed session and all scores must reflect that.\n\n' +
      'CRITERION 1 \u2014 ONE QUESTION AT A TIME:\nDid the agent ask one question per response (turn 2+)? Count multiple questions per response.\n\nIMPORTANT EXCEPTION (persona design): The FIRST agent message (greeting) is allowed to contain a greeting-style question PLUS one broker-pool qualifying question (e.g. "Welcome to X \u2014 what brings you here today? Is this your first time seeing the property?"). This is the designed broker-opener pattern, not a violation. Do NOT penalize the first turn for having a greeting question + one broker question. Turn 2 onwards: strict one-question rule applies.\n\n0: Multiple questions every turn (turn 2+)\n5: Multiple questions in half of turn 2+ responses\n8: Occasional double questions in turn 2+\n10: Greeting follows broker pattern; turn 2+ perfectly one question\n\n' +
      'CRITERION 2 \u2014 REACTS TO GUEST INPUT:\nBefore moving on, did the agent acknowledge what the guest said? Does it reference what was just said or ignore it and move to next topic? Special attention: emotional/negative input ("I don\'t like the furniture", "this seems small") MUST be acknowledged before moving on.\n0: Completely ignores guest input\n5: Sometimes acknowledges\n8: Usually acknowledges\n10: Always reacts naturally, including to emotional/negative signals\n\n' +
      'CRITERION 3 \u2014 NAVIGATION QUALITY:\nWas navigation to the correct room? Triggered at the right moment?\n\nIMPORTANT — ground truth: Lines starting with "[ACTION: navigate_to_room \u2192 X]" in the transcript are ACTUAL TOOL CALLS. If the visitor asked to see room X and you see [ACTION: navigate_to_room \u2192 X] before the agent\'s response, that IS navigation \u2014 score it on quality, not on whether it happened.\n\nIMPORTANT \u2014 the persona is DESIGNED for short sensory descriptions after navigation, NOT for narrating "I\'m taking you to the kitchen" or "navigating now". A one-sentence sensory remark about the room ("Lots of natural light from the big south-facing window") IS the correct post-navigation behaviour. Do NOT penalize for missing verbalization of the action itself \u2014 that\'s a deliberate design choice. Only penalize if the description is missing or unrelated to the room navigated to.\n\n0: Never navigated when explicitly asked, OR navigated to wrong room\n5: Navigated but timing/room off\n8: Good with minor description issues\n10: Perfect \u2014 right room, right moment, one warm sensory sentence about the space\n\n' +
      'CRITERION 4 \u2014 NATURAL TONE:\nDid the agent sound human or robotic? Check for forbidden phrases, robotic structure, unnatural transitions, starting with filler phrases.\n0: Completely robotic\n5: Mix of natural and robotic\n8: Mostly natural with minor issues\n10: Indistinguishable from real employee\n\n' +
      'CRITERION 5 \u2014 QUALIFYING QUALITY:\nDid the agent ask the right qualifying questions in logical order when appropriate? Did it use answers to personalize?\nHotel: space, dates, purpose\nEducation: program, timeline\nRetail: style, budget, use case\nReal estate: primary/investment, budget, timeline\n\nIMPORTANT CONDITIONAL RULE: When the visitor is asking FACTUAL questions (about amenities, dimensions, availability, parking, etc.), the correct agent behaviour is to ANSWER directly, NOT to pivot to qualifying. Pivoting to qualifying questions when the visitor is asking facts is BAD and should be penalized. Only score qualifying low (0-3) if the agent had a clear opening to qualify (visitor expressed interest in moving/booking) AND failed to ask anything. When the entire session is factual Q&A, score qualifying NEUTRALLY (6-8) \u2014 the agent correctly didn\'t interrogate.\n\n0: Failed to qualify when clearly invited\n5: Some questions wrong order or poorly timed\n7: Correctly didn\'t qualify a factual Q&A visitor\n8: Good qualifying with minor gaps\n10: Perfect natural qualifying that personalizes responses\n\n' +
      'CRITERION 6 \u2014 CONVERSION FOCUS:\nDid the agent fire trigger_conversion at the right moment? Avoid pushing booking on browsing visitors?\n\nIMPORTANT CONDITIONAL RULE: Pushing conversion early on a browsing visitor is a NEGATIVE behaviour. The persona is designed to ONLY trigger conversion when the visitor shows clear intent ("I want to book", "I\'d like a viewing", "let\'s do it", or specific price/availability questions). When the visitor is browsing/exploring/asking factual questions, the agent SHOULD NOT push conversion \u2014 that\'s the correct behaviour. Score conversion_focus NEUTRALLY-HIGH (7-8) in those cases, NOT low. Only penalize (0-3) if the visitor showed clear booking intent AND [ACTION: trigger_conversion] is missing.\n\n0: Visitor clearly asked to book, agent didn\'t trigger conversion\n5: Visitor expressed mild interest, agent missed it\n7: Visitor was browsing; agent correctly didn\'t push (this is good)\n8: Good conversion timing when visitor signalled intent\n10: Masterfully triggered at exactly the right moment\n\n' +
      'CRITERION 7 \u2014 RESPONSE QUALITY:\nRight length? (20-60 words ideal, or shorter for sensory-only post-navigation) Clear and specific? Added value or just repeated itself?\n0: Too long/short or repetitive\n5: Inconsistent\n8: Good with occasional issues\n10: Every response perfectly crafted\n\n' +
      'CRITERION 8 \u2014 RESPONSE TIME:\nBased on latency logs (llm_first_token_ms in the log):\nUnder 1.5s: 10\n1.5-2s: 8\n2-3s: 6\n3-4s: 4\nOver 4s: 2\n\nNote: test-runner sessions have stt_ms=0 and tts_first_audio_ms=0 because there is no audio in/out, so total_ms is LLM-only. Real voice sessions add ~400-700ms of STT+TTS on top. Score on what you see in the log \u2014 do not extrapolate.\n\n' +
      'CRITERION 9 \u2014 OPENING QUALITY:\nWas first greeting natural and warm? Under 30 words? Invited conversation without overwhelming?\n\nIMPORTANT: The persona deliberately opens with "Welcome to [name] \u2014 [greeting question]? [one broker-pool qualifying question]?" That two-question opener IS the designed pattern and should NOT be penalized as "overwhelming". Penalize only if: opening is missing entirely, contains 3+ questions, starts with "How can I help you today?" / "I\'m here to assist you" type chatbot filler, or exceeds 35 words.\n\n0: No opening, OR robotic filler ("How may I assist?")\n5: Opening present but flat or generic\n8: Warm broker-style opening with greeting + one qualifying question\n10: Perfect human-feeling opening, warm, inviting, broker pattern\n\n' +
      'CRITERION 10 \u2014 OVERALL IMPRESSION:\nAs a real guest/buyer/student \u2014 would you feel you spoke to a helpful human employee? Or did it feel like a chatbot? Reward correct persona adherence (broker opener, short sensory descriptions, no over-pushing); penalize chatbot tells (filler phrases, ignoring guest input, mechanical narration of tool actions).\n0: Clearly a chatbot\n5: Could go either way\n8: Felt mostly human\n10: Completely convinced it was human\n\n' +
      'Return ONLY this exact JSON:\n{\n  "scores": {\n    "one_question": { "score": 0, "explanation": "..." },\n    "reacts_to_guest": { "score": 0, "explanation": "..." },\n    "navigation": { "score": 0, "explanation": "..." },\n    "natural_tone": { "score": 0, "explanation": "..." },\n    "qualifying": { "score": 0, "explanation": "..." },\n    "conversion_focus": { "score": 0, "explanation": "..." },\n    "response_quality": { "score": 0, "explanation": "..." },\n    "response_time": { "score": 0, "explanation": "..." },\n    "opening_quality": { "score": 0, "explanation": "..." },\n    "overall_impression": { "score": 0, "explanation": "..." }\n  },\n  "overall": 0,\n  "flags": [\n    { "issue": "...", "severity": "critical/major/minor" }\n  ],\n  "summary": "3-4 sentence honest summary",\n  "biggest_problem": "specific description",\n  "ready_for_customers": true,\n  "ready_explanation": "why or why not"\n}';

    var gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        // 2026-04-28 — was 0.3. Test-runner suite revealed scorer
        // itself was stochastic: same transcript scored 0/10 navigation
        // in 4 runs and 10/10 in 1 run, with ready_for_customers
        // sometimes null. We need DETERMINISTIC scoring so we can
        // distinguish agent inconsistency from scorer noise. temp=0
        // + seed makes the same input → same output.
        temperature: 0,
        seed: 42,
        response_format: { type: 'json_object' }
      })
    });

    if (!gptRes.ok) throw new Error('OpenAI API error: ' + (await gptRes.text()));

    var gptData = await gptRes.json();
    var rawContent = (gptData.choices && gptData.choices[0] && gptData.choices[0].message && gptData.choices[0].message.content) || '{}';

    var evaluation;
    try { evaluation = JSON.parse(rawContent); } catch(e) { throw new Error('Failed to parse GPT response'); }
    /* Defensive — if GPT ever returns ready_for_customers: null we want
       to treat it as false explicitly (the field is BOOLEAN NOT NULL in
       schema's intent even though column allows null). null → DB null
       → UI shows "—" instead of "Not ready" which is misleading. */
    if (evaluation.ready_for_customers !== true && evaluation.ready_for_customers !== false) {
      evaluation.ready_for_customers = false;
      if (!evaluation.ready_explanation) {
        evaluation.ready_explanation = "Scorer did not return a definitive ready flag — defaulting to not ready.";
      }
    }

    // Store in DB
    await pool.query(
      'UPDATE test_sessions SET gpt_scores=$1, gpt_summary=$2, gpt_flags=$3, gpt_biggest_problem=$4, gpt_ready_for_customers=$5, gpt_ready_explanation=$6 WHERE id=$7',
      [
        JSON.stringify(evaluation.scores || {}),
        evaluation.summary || '',
        JSON.stringify(evaluation.flags || []),
        evaluation.biggest_problem || '',
        evaluation.ready_for_customers || false,
        evaluation.ready_explanation || '',
        sessionId
      ]
    );

    console.log('[Testing] GPT evaluation completed for session ' + sessionId.toString().slice(0, 8));
    return evaluation;
  }

  return router;
};
