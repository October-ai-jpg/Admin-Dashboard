const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const multer = require('multer');
const pdfParse = require('pdf-parse');

/* ── Production-identical services ── */
const { mergePropertyData } = require('./services/dataMerger');
const { compileContext } = require('./services/contextCompiler');
const { buildSystemPrompt, buildTools, VERTICAL_CONFIG } = require('./services/agentPersona');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'october-admin-2026';

/* ══════════════════════════════════════════
   DATABASE — READ-ONLY to October AI's DB
   ══════════════════════════════════════════ */
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

/* ══════════════════════════════════════════
   LOCAL DATA STORE — for prompts, configs, test history
   ══════════════════════════════════════════ */
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file) {
  const p = path.join(DATA_DIR, file);
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {}
  return [];
}
function saveJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

/* ══════════════════════════════════════════
   MIDDLEWARE
   ══════════════════════════════════════════ */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* Auth middleware — check ADMIN_SECRET */
function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === ADMIN_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

/* ══════════════════════════════════════════
   AUTH ROUTES
   ══════════════════════════════════════════ */
app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_SECRET) {
    res.json({ ok: true, token: ADMIN_SECRET });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.get('/auth/verify', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token === ADMIN_SECRET) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/* ══════════════════════════════════════════
   MONITORING API — READ-ONLY DB QUERIES
   ══════════════════════════════════════════ */
const monitoringRoutes = require('./routes/monitoring');
app.use('/api/monitoring', requireAuth, monitoringRoutes(pool));

/* ══════════════════════════════════════════
   PROMPTS & CONFIGURATIONS API
   ══════════════════════════════════════════ */
const promptsRoutes = require('./routes/prompts');
app.use('/api/prompts', requireAuth, promptsRoutes(loadJSON, saveJSON));

const configsRoutes = require('./routes/configs');
app.use('/api/configs', requireAuth, configsRoutes(loadJSON, saveJSON));

const historyRoutes = require('./routes/history');
app.use('/api/history', requireAuth, historyRoutes(loadJSON, saveJSON));

/* ══════════════════════════════════════════
   HEALTH CHECK ROUTE
   ══════════════════════════════════════════ */
app.get('/api/health-check', requireAuth, async (req, res) => {
  const results = {};

  // Check DB
  try {
    if (pool) {
      const start = Date.now();
      await pool.query('SELECT 1');
      results.database = { status: 'online', latency: Date.now() - start };
    } else {
      results.database = { status: 'not_configured' };
    }
  } catch(e) {
    results.database = { status: 'offline', error: e.message };
  }

  // Check OpenAI
  try {
    const start = Date.now();
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': 'Bearer ' + (process.env.OPENAI_API_KEY || '') }
    });
    results.openai = { status: r.ok ? 'online' : 'error', latency: Date.now() - start };
  } catch(e) {
    results.openai = { status: 'offline', error: e.message };
  }

  // Check Deepgram
  try {
    const start = Date.now();
    const r = await fetch('https://api.deepgram.com/v1/projects', {
      headers: { 'Authorization': 'Token ' + (process.env.DEEPGRAM_API_KEY || '') }
    });
    results.deepgram = { status: r.ok ? 'online' : 'error', latency: Date.now() - start };
  } catch(e) {
    results.deepgram = { status: 'offline', error: e.message };
  }

  // Check Cartesia
  try {
    const start = Date.now();
    const r = await fetch('https://api.cartesia.ai/voices', {
      headers: { 'X-API-Key': process.env.CARTESIA_API_KEY || '', 'Cartesia-Version': '2024-06-10' }
    });
    results.cartesia = { status: r.ok ? 'online' : 'error', latency: Date.now() - start };
  } catch(e) {
    results.cartesia = { status: 'offline', error: e.message };
  }

  res.json(results);
});

/* ══════════════════════════════════════════
   API KEY CHECK — for frontend banner
   ══════════════════════════════════════════ */
app.get('/api/check-keys', requireAuth, (req, res) => {
  res.json({
    openai: !!process.env.OPENAI_API_KEY,
    deepgram: !!process.env.DEEPGRAM_API_KEY,
    cartesia: !!process.env.CARTESIA_API_KEY,
    database: !!pool
  });
});

/* ══════════════════════════════════════════
   SCRAPE — Jina Reader + OpenAI extraction
   ══════════════════════════════════════════ */
app.post('/admin/scrape', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    // 1. Fetch via Jina Reader
    console.log('[SCRAPE] Fetching:', url);
    const jinaResponse = await fetch('https://r.jina.ai/' + url, {
      headers: { 'Accept': 'text/plain' },
      signal: AbortSignal.timeout(20000)
    });
    if (!jinaResponse.ok) {
      throw new Error('Jina Reader error: ' + jinaResponse.status);
    }
    var rawText = await jinaResponse.text();

    // Truncate if too long
    if (rawText.length > 50000) {
      rawText = rawText.substring(0, 50000) + '\n[Truncated]';
    }

    // 2. Extract with OpenAI if key available
    if (process.env.OPENAI_API_KEY && rawText.length > 100) {
      console.log('[SCRAPE] Extracting with OpenAI...');
      const llmResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Extract all useful business information from this website content. Return as clean, structured text. Include: business name, description, services/products, rooms/spaces, pricing, hours, contact info, location, policies, and any other relevant details. Output text only, no markdown formatting.' },
            { role: 'user', content: rawText.substring(0, 30000) }
          ],
          max_tokens: 2000,
          temperature: 0.3
        }),
        signal: AbortSignal.timeout(25000)
      });
      if (llmResponse.ok) {
        const llmData = await llmResponse.json();
        const extracted = llmData.choices?.[0]?.message?.content || rawText;
        console.log('[SCRAPE] Extracted', extracted.length, 'chars');
        return res.json({ text: extracted, source: 'extracted' });
      }
    }

    // Fallback: return raw text
    res.json({ text: rawText, source: 'raw' });
  } catch(e) {
    console.error('[SCRAPE] Error:', e.message);
    res.status(500).json({ error: 'Could not access this URL. Try pasting the content manually.' });
  }
});

/* ══════════════════════════════════════════
   FILE UPLOAD — Extract text from PDF/files
   ══════════════════════════════════════════ */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

/* Clean up raw extracted text (PDF artifacts, excessive whitespace, etc.) */
function cleanExtractedText(raw) {
  let t = raw;
  // Normalise line endings
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Remove form-feed / page-break characters
  t = t.replace(/\f/g, '\n\n');
  // Remove null bytes and other control chars (keep \n \t)
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  // Collapse runs of spaces/tabs on the same line
  t = t.replace(/[ \t]+/g, ' ');
  // Remove trailing spaces on each line
  t = t.replace(/ +\n/g, '\n');
  // Fix lines that were split mid-word by PDF extraction (word- \n continuation)
  t = t.replace(/(\w)-\s*\n\s*(\w)/g, '$1$2');
  // Merge lines that are part of the same paragraph (line doesn't end with punctuation or isn't short heading)
  t = t.replace(/([^\n.!?:;])\n(?=[a-zæøå0-9(])/g, '$1 $2');
  // Collapse 3+ blank lines into 2
  t = t.replace(/\n{3,}/g, '\n\n');
  // Trim leading/trailing whitespace
  t = t.trim();
  return t;
}

app.post('/admin/extract-file', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { originalname, mimetype, buffer } = req.file;
  const ext = path.extname(originalname).toLowerCase();
  console.log('[EXTRACT] File:', originalname, 'Type:', mimetype, 'Size:', buffer.length);

  try {
    let rawText = '';
    let pages = 0;

    if (ext === '.pdf' || mimetype === 'application/pdf') {
      const data = await pdfParse(buffer);
      rawText = data.text || '';
      pages = data.numpages || 0;
      console.log('[EXTRACT] PDF pages:', pages, 'chars:', rawText.length);
    } else if (['.txt', '.csv', '.json', '.md', '.xml', '.html'].includes(ext)) {
      rawText = buffer.toString('utf-8');
    } else if (ext === '.docx') {
      // Basic docx: extract text between <w:t> tags from word/document.xml
      const AdmZip = (() => { try { return require('adm-zip'); } catch(e) { return null; } })();
      if (AdmZip) {
        const zip = new AdmZip(buffer);
        const doc = zip.getEntry('word/document.xml');
        if (doc) {
          const xml = doc.getData().toString('utf-8');
          rawText = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
      } else {
        rawText = buffer.toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    } else {
      rawText = buffer.toString('utf-8');
    }

    if (!rawText.trim()) {
      return res.json({ text: '', source: 'empty', filename: originalname, pages });
    }

    // Clean up raw text (remove PDF artifacts, fix line breaks, etc.)
    rawText = cleanExtractedText(rawText);

    // Optionally structure with OpenAI
    if (process.env.OPENAI_API_KEY && rawText.length > 100) {
      try {
        const llmResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Extract all useful business information from this document. Return as clean, structured text. Include: business name, description, services/products, rooms/spaces, pricing, hours, contact info, location, policies, and any other relevant details. Output text only, no markdown formatting.' },
              { role: 'user', content: rawText.substring(0, 30000) }
            ],
            max_tokens: 2000,
            temperature: 0.3
          }),
          signal: AbortSignal.timeout(25000)
        });
        if (llmResponse.ok) {
          const llmData = await llmResponse.json();
          const extracted = llmData.choices?.[0]?.message?.content || rawText;
          return res.json({ text: extracted, source: 'structured', filename: originalname, pages });
        }
      } catch(llmErr) {
        console.log('[EXTRACT] GPT structuring failed, using cleaned text:', llmErr.message);
      }
    }

    res.json({ text: rawText.substring(0, 50000), source: 'cleaned', filename: originalname, pages });
  } catch(e) {
    console.error('[EXTRACT] Error:', e.message);
    res.status(500).json({ error: 'Could not extract text from this file: ' + e.message });
  }
});

/* ══════════════════════════════════════════
   COMPILE CONTEXT — GPT-4o-mini structuring
   (identical to production contextCompiler)
   ══════════════════════════════════════════ */
app.post('/admin/compile-context', requireAuth, async (req, res) => {
  const { propertyData, propertyName, vertical, bookingUrl, roomMappings } = req.body;
  if (!propertyData || propertyData.length < 50) {
    return res.status(400).json({ error: 'Property data too short (min 50 chars)' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'OPENAI_API_KEY not configured — cannot compile context' });
  }
  try {
    const startTime = Date.now();
    const compiled = await compileContext(propertyData, propertyName, vertical, bookingUrl, roomMappings);
    if (!compiled) {
      return res.status(500).json({ error: 'Compilation returned empty result' });
    }
    res.json({
      compiledContext: compiled,
      chars: compiled.length,
      durationMs: Date.now() - startTime
    });
  } catch (e) {
    console.error('[COMPILE] Error:', e.message);
    res.status(500).json({ error: 'Compilation failed: ' + e.message });
  }
});

/* ══════════════════════════════════════════
   PREVIEW PROMPT — show what agentPersona generates
   (read-only preview, identical to production)
   ══════════════════════════════════════════ */
app.post('/admin/preview-prompt', requireAuth, (req, res) => {
  const {
    vertical = 'hotel',
    agentName = '',
    propertyName = '',
    compiledContext = '',
    language = 'en',
    conversionUrl = '',
    roomMappings = {},
    turnCount = 0,
    conversationState = 'greeting',
    userProfile = {},
    navigatedRooms = [],
    elapsedMinutes = 0,
    propertyDetails = null
  } = req.body;

  // Build places map from roomMappings (supports both label-object and flat-string forms)
  var places = {};
  if (roomMappings && typeof roomMappings === 'object') {
    Object.keys(roomMappings).forEach(function(key) {
      var entry = roomMappings[key];
      places[key] = typeof entry === 'object' ? (entry.label || key) : entry;
    });
  }

  try {
    var systemPrompt = buildSystemPrompt({
      vertical,
      propertyName: agentName || propertyName,
      places,
      compiledContext,
      language,
      dateTime: new Date().toLocaleString('en-GB', { timeZone: 'Europe/Copenhagen' }),
      conversationState,
      userProfile,
      navigatedRooms,
      lastRecommendedRoom: null,
      turnCount,
      elapsedMinutes,
      roomMappings,
      propertyDetails
    });

    var tools = buildTools({
      places,
      vertical
    });

    res.json({
      systemPrompt,
      tools,
      characterCount: systemPrompt.length,
      toolCount: tools.length
    });
  } catch (e) {
    console.error('[PREVIEW] Error:', e.message);
    res.status(500).json({ error: 'Preview failed: ' + e.message });
  }
});

/* ══════════════════════════════════════════
   PRODUCTION STATUS — read-only DB snapshot
   ══════════════════════════════════════════ */
app.get('/admin/production-status', requireAuth, async (req, res) => {
  const vertical = req.query.vertical || 'hotel';

  // Hardcoded production values (always available, even without DB)
  const prodConfig = {
    model: 'gpt-5.4-mini',
    temperature: 0.7,
    vadSilenceFrames: 50,
    sttModel: 'Deepgram Nova-2',
    ttsModel: 'Cartesia Flash'
  };

  if (!pool) {
    // Return hardcoded production defaults without DB stats
    return res.json({
      vertical: vertical,
      model: prodConfig.model,
      temperature: prodConfig.temperature,
      vadSilenceFrames: prodConfig.vadSilenceFrames,
      sttModel: prodConfig.sttModel,
      ttsModel: prodConfig.ttsModel,
      tenantCount: '—',
      avgConversion: '—',
      avgMinutes: '—'
    });
  }

  try {
    // Tenant count for this vertical
    const tenantRes = await pool.query(
      "SELECT COUNT(*) AS cnt FROM tenants WHERE vertical = $1 AND is_active = true",
      [vertical]
    );
    const tenantCount = parseInt(tenantRes.rows[0]?.cnt || 0);

    // Average conversion rate for this vertical (last 30 days)
    const convRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE converted = true) AS conversions,
         COUNT(*) AS total
       FROM conversations
       WHERE vertical = $1
         AND created_at > NOW() - INTERVAL '30 days'`,
      [vertical]
    );
    const total = parseInt(convRes.rows[0]?.total || 0);
    const conversions = parseInt(convRes.rows[0]?.conversions || 0);
    const avgConversion = total > 0 ? ((conversions / total) * 100).toFixed(1) : '0.0';

    // Average minutes used per month (active tenants on this vertical)
    let avgMinutes = 0;
    try {
      const minRes = await pool.query(
        `SELECT AVG(minutes_used_this_month) AS avg_min
         FROM tenants WHERE vertical = $1 AND is_active = true`,
        [vertical]
      );
      avgMinutes = parseFloat(minRes.rows[0]?.avg_min || 0).toFixed(1);
    } catch(e) { /* column may not exist */ }

    res.json({
      vertical: vertical,
      model: prodConfig.model,
      temperature: prodConfig.temperature,
      vadSilenceFrames: prodConfig.vadSilenceFrames,
      sttModel: prodConfig.sttModel,
      ttsModel: prodConfig.ttsModel,
      tenantCount: tenantCount,
      avgConversion: avgConversion,
      avgMinutes: avgMinutes
    });
  } catch (e) {
    console.error('[PROD-STATUS] Error:', e.message);
    res.json({ error: 'Query failed' });
  }
});

/* ══════════════════════════════════════════
   SPA FALLBACK — serve dashboard.html
   ══════════════════════════════════════════ */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/dashboard/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

/* ══════════════════════════════════════════
   WEBSOCKET — Test sandbox voice pipeline
   ══════════════════════════════════════════ */
const wss = new WebSocket.Server({ noServer: true });
const { handleTestSession } = require('./voice/pipeline');

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/ws/test') {
    const token = url.searchParams.get('token');
    if (token !== ADMIN_SECRET) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  console.log('Sandbox test session connected');
  handleTestSession(ws);
});

/* ══════════════════════════════════════════
   START
   ══════════════════════════════════════════ */
server.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║    October AI — Admin Dashboard           ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log('  Port:', PORT);
  console.log('  Database:', pool ? 'connected' : 'NOT CONFIGURED');
  console.log('');
  // API key checks
  if (!process.env.OPENAI_API_KEY)   console.error('  ⚠ MISSING: OPENAI_API_KEY');
  else                               console.log('  ✓ OPENAI_API_KEY set');
  if (!process.env.DEEPGRAM_API_KEY) console.error('  ⚠ MISSING: DEEPGRAM_API_KEY');
  else                               console.log('  ✓ DEEPGRAM_API_KEY set');
  if (!process.env.CARTESIA_API_KEY) console.error('  ⚠ MISSING: CARTESIA_API_KEY');
  else                               console.log('  ✓ CARTESIA_API_KEY set');
  console.log('');
});
