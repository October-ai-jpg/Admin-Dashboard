const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const multer = require('multer');
const { PDFParse } = require('pdf-parse'); // v2.x API — class, not default function

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
      // pdf-parse v2.x: instantiate class, call getText()
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        rawText = result.text || '';
        pages = result.total || (result.pages && result.pages.length) || 0;
        console.log('[EXTRACT] PDF pages:', pages, 'chars:', rawText.length);
      } finally {
        try { await parser.destroy(); } catch (e) {}
      }
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
   CLIENT PORTAL — Demo account (1:1 replica)
   Serves the production client portal pages
   with mock data at /client/demo/*
   ══════════════════════════════════════════ */

/* Demo mock data — fresh empty state, matches production schema */
const DEMO_DATA = {
  tenantId: 'demo-tenant-001',
  agentName: '',
  propertyName: '',
  vertical: '',
  language: 'en',
  brandColor: '#1a1a1a',
  bookingUrl: '',
  website: '',
  matterportUrl: '',
  demoQuestions: [],
  property_data: '',
  roomMappings: {},
  tenants: [
    { id: 'demo-tenant-001', name: 'Demo Agent' }
  ],
  analytics: {
    conversations30d: 0,
    bookings30d: 0,
    conversionRate: 0,
    avgDuration: 0,
    totalVisitors: 0,
    spacesShown: 0,
    popularQuestions: [],
    roomPerformance: [],
    leads: []
  },
  usage: {
    minutesUsed: 0,
    quotaMinutes: 1000
  },
  subscription: {
    status: 'active',
    nextBillingDate: '2026-05-01T00:00:00Z'
  },
  floorplanImage: '',
  scrapeStatus: null,
  scrapeMessage: null
};

/* Demo conversations — empty, will populate as agent is used */
const DEMO_CONVERSATIONS = [];

/* Generate demo messages for a conversation */
function generateDemoMessages(convId) {
  return [];
}

/* ── Demo data endpoint ── */
app.get('/client/demo/data', (req, res) => {
  res.json(DEMO_DATA);
});

/* ── Demo preview endpoint ── */
app.get('/client/demo/preview', (req, res) => {
  res.json({ tenantId: DEMO_DATA.tenantId });
});

/* ── Demo update endpoint ── */
app.post('/client/demo/update', express.json(), (req, res) => {
  /* Accept updates to demo data (in-memory only) */
  const body = req.body || {};
  if (body.agentName) DEMO_DATA.agentName = body.agentName;
  if (body.language) DEMO_DATA.language = body.language;
  if (body.brandColor) DEMO_DATA.brandColor = body.brandColor;
  if (body.bookingUrl) DEMO_DATA.bookingUrl = body.bookingUrl;
  if (body.demoQuestions) DEMO_DATA.demoQuestions = body.demoQuestions;
  if (body.vertical) DEMO_DATA.vertical = body.vertical;
  if (body.property_data !== undefined) DEMO_DATA.property_data = body.property_data;
  if (body.website) DEMO_DATA.website = body.website;
  if (body.matterportUrl) DEMO_DATA.matterportUrl = body.matterportUrl;
  if (body.floorplanImage !== undefined) DEMO_DATA.floorplanImage = body.floorplanImage;
  res.json({ ok: true });
});

/* ── Demo upload text ── */
app.post('/client/demo/upload', express.json(), (req, res) => {
  const text = (req.body && req.body.text) || '';
  if (text) {
    DEMO_DATA.property_data = (DEMO_DATA.property_data || '') + '\n\n' + text;
  }
  const words = DEMO_DATA.property_data.trim().split(/\s+/).length;
  res.json({ ok: true, wordCount: words });
});

/* ── Demo upload file ── */
app.post('/client/demo/upload-file', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { originalname, mimetype, buffer } = req.file;
  const ext = path.extname(originalname).toLowerCase();

  try {
    let rawText = '';

    if (ext === '.pdf' || mimetype === 'application/pdf') {
      try {
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
          const result = await parser.getText();
          rawText = result.text || '';
        } finally {
          try { await parser.destroy(); } catch (e) {}
        }
      } catch (pdfErr) {
        console.log('[DEMO-UPLOAD] PDF parse failed, treating as raw text:', pdfErr.message);
        rawText = buffer.toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    } else if (['.txt', '.csv', '.json', '.md', '.xml', '.html'].includes(ext)) {
      rawText = buffer.toString('utf-8');
    } else if (ext === '.docx') {
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

    rawText = cleanExtractedText(rawText);
    if (rawText) {
      DEMO_DATA.property_data = (DEMO_DATA.property_data || '') + '\n\n' + rawText;
    }
    const words = DEMO_DATA.property_data.trim().split(/\s+/).length;
    res.json({ ok: true, wordCount: words });
  } catch (e) {
    console.error('[DEMO-UPLOAD] Error:', e.message);
    res.json({ ok: true, wordCount: DEMO_DATA.property_data.trim().split(/\s+/).length });
  }
});

/* ── Demo scrape ── */
app.post('/client/demo/scrape', (req, res) => {
  /* Simulate async scrape — mark as done immediately */
  DEMO_DATA.scrapeStatus = 'done';
  DEMO_DATA.scrapeMessage = 'Sync complete — 1,847 words collected from 12 pages';
  res.json({ ok: true });
  /* Reset scrape status after 10 seconds */
  setTimeout(() => { DEMO_DATA.scrapeStatus = null; DEMO_DATA.scrapeMessage = null; }, 10000);
});

/* ── Demo spaces CRUD ── */
app.post('/client/demo/spaces/add', express.json(), (req, res) => {
  const { label, sweepId } = req.body || {};
  if (!label) return res.status(400).json({ error: 'Label required' });
  const key = label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  DEMO_DATA.roomMappings[key] = { label, sweepId: sweepId || '' };
  res.json({ ok: true, roomMappings: DEMO_DATA.roomMappings });
});

app.post('/client/demo/spaces/update', express.json(), (req, res) => {
  const { roomId, label, sweepId } = req.body || {};
  if (roomId && DEMO_DATA.roomMappings[roomId]) {
    DEMO_DATA.roomMappings[roomId] = { label: label || DEMO_DATA.roomMappings[roomId].label, sweepId: sweepId || '' };
  }
  res.json({ ok: true, roomMappings: DEMO_DATA.roomMappings });
});

app.post('/client/demo/spaces/delete', express.json(), (req, res) => {
  const { roomId } = req.body || {};
  if (roomId) delete DEMO_DATA.roomMappings[roomId];
  res.json({ ok: true, roomMappings: DEMO_DATA.roomMappings });
});

/* ── Demo conversations list ── */
app.get('/client/demo/conversations', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const filter = req.query.filter || 'all';
  let convos = DEMO_CONVERSATIONS.map(c => ({
    id: c.id,
    created_at: c.date,
    duration_seconds: c.duration,
    message_count: c.messageCount,
    rooms_shown: c.spacesShown.join(', '),
    had_booking_click: c.converted
  }));
  if (filter === 'converted') convos = convos.filter(c => c.had_booking_click);
  else if (filter === 'not_converted') convos = convos.filter(c => !c.had_booking_click);
  const total = convos.length;
  const paged = convos.slice((page - 1) * limit, page * limit);
  res.json({ conversations: paged, total, page, limit });
});

/* ── Demo conversation messages ── */
app.get('/client/demo/conversations/:id/messages', (req, res) => {
  res.json(generateDemoMessages(req.params.id));
});

/* ── Demo purchase minutes ── */
app.post('/client/demo/purchase-minutes', express.json(), (req, res) => {
  /* Simulate Stripe checkout redirect */
  res.json({ checkoutUrl: '/client/demo/settings?purchase=success' });
});

/* ── Demo report endpoint ── */
app.get('/client/demo/report', (req, res) => {
  res.type('text/plain').send('Demo Report — Harbour View Hotel\n\nConversations: 847\nConversions: 127\nConversion Rate: 15%\nAvg Duration: 4m 5s\n\nGenerated by October AI Demo');
});

/* ── Demo leads export ── */
app.get('/client/demo/leads/export', (req, res) => {
  let csv = 'Name,Email,Phone,Date,Converted\n';
  (DEMO_DATA.analytics.leads || []).forEach(l => {
    csv += `"${l.guest_name}","${l.guest_email}","${l.guest_phone}","${l.created_at}","${l.had_booking_click}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=leads.csv');
  res.send(csv);
});

/* ── Serve client portal pages ── */
const CLIENT_PAGES = ['agent', 'build', 'analytics', 'conversations', 'leads', 'knowledge', 'settings'];

app.get('/client/demo', (req, res) => {
  res.redirect('/client/demo/agent');
});

app.get('/client/demo/:page', (req, res) => {
  const page = req.params.page;
  if (CLIENT_PAGES.includes(page)) {
    res.sendFile(path.join(__dirname, 'public', 'client', 'pages', page + '.html'));
  } else {
    res.status(404).send('Page not found');
  }
});

/* Also serve analytics sub-pages */
app.get('/client/demo/analytics/:sub', (req, res) => {
  const sub = req.params.sub;
  if (['conversations', 'leads', 'report'].includes(sub)) {
    if (sub === 'report') {
      return res.redirect('/client/demo/report');
    }
    res.sendFile(path.join(__dirname, 'public', 'client', 'pages', sub + '.html'));
  } else {
    res.status(404).send('Page not found');
  }
});

/* ── Room Mapper page ── */
app.get('/rooms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'rooms.html'));
});

/* ── Demo tour config (for Room Mapper) ── */
app.get('/api/tour/:tenantId/config', (req, res) => {
  /* Extract model ID from Matterport URL */
  const mUrl = DEMO_DATA.matterportUrl || '';
  const mMatch = mUrl.match(/[?&]m=([^&]+)/);
  const modelId = mMatch ? mMatch[1] : 'SxQL3iGyoDo';
  res.json({
    modelId: modelId,
    propertyName: DEMO_DATA.propertyName || 'Demo Property',
    vertical: DEMO_DATA.vertical || 'hotel'
  });
});

/* ── Demo rooms GET (for Room Mapper) ── */
app.get('/api/my/tenants/:tenantId/rooms', (req, res) => {
  res.json({ rooms: DEMO_DATA.roomMappings || {} });
});

/* ── Demo rooms PUT (for Room Mapper save) ── */
app.put('/api/my/tenants/:tenantId/rooms', express.json(), (req, res) => {
  const { roomMappings } = req.body || {};
  if (roomMappings && typeof roomMappings === 'object') {
    DEMO_DATA.roomMappings = roomMappings;
  }
  res.json({ ok: true, rooms: DEMO_DATA.roomMappings });
});

/* ══════════════════════════════════════════
   SPA FALLBACK — serve dashboard.html
   ══════════════════════════════════════════ */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/dashboard/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

/* ══════════════════════════════════════════
   WEBSOCKET — Voice pipeline (1:1 with October AI production)
   The voiceServer module holds the full production session loop
   (createSession, generateGreeting, processTurn, silence timer,
   20-minute farewell). server.js only handles auth + upgrade routing.
   ══════════════════════════════════════════ */
const { createVoiceWSS } = require('./voice/voiceServer');
const voiceWss = createVoiceWSS();

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/ws/test' || url.pathname === '/ws/voice') {
    const token = url.searchParams.get('token');
    if (token !== ADMIN_SECRET) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    voiceWss.handleUpgrade(request, socket, head, (ws) => {
      voiceWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
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
