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

/* Demo mock data — matches production schema exactly */
const DEMO_DATA = {
  tenantId: 'demo-tenant-001',
  agentName: 'Harbour View Hotel',
  propertyName: 'Harbour View Hotel',
  vertical: 'hotel',
  language: 'en',
  brandColor: '#1a1a1a',
  bookingUrl: 'https://booking.example.com/harbour-view',
  website: 'https://harbourviewhotel.example.com',
  matterportUrl: 'https://my.matterport.com/show/?m=SxQL3iGyoDo',
  demoQuestions: [
    'Can you show me around the hotel?',
    'What room types do you have?',
    'Tell me about your restaurant',
    'What amenities are available?',
    'How do I book a room?'
  ],
  property_data: 'Harbour View Hotel — Boutique Waterfront Accommodation\n\nLocated on the scenic harbour front, Harbour View Hotel offers 42 individually designed rooms across 4 categories: Standard (18m², city view), Superior (24m², partial harbour view), Deluxe (32m², full harbour view with balcony), and Suite (48m², panoramic harbour view with separate living area).\n\nFacilities:\n- The Lighthouse Restaurant: Fine dining with panoramic harbour views, open daily 7:00–22:00\n- Harbour Bar: Cocktails and light bites, open 16:00–00:00\n- Wellness Centre: Sauna, steam room, fitness area, open 06:00–22:00\n- Rooftop Terrace: Seasonal outdoor lounge with 360° views\n- Meeting Room: Seats up to 20, projector and whiteboard included\n- Free high-speed WiFi throughout\n- Private parking: 15 EUR/night\n\nCheck-in: 15:00 | Check-out: 11:00\nEarly check-in and late check-out available on request.\n\nPricing (per night):\n- Standard: from 129 EUR\n- Superior: from 179 EUR\n- Deluxe: from 249 EUR\n- Suite: from 379 EUR\n\nAll rates include breakfast buffet.\n\nContact: info@harbourviewhotel.com | +45 33 12 34 56\nAddress: Havnegade 42, 1058 Copenhagen K, Denmark',
  roomMappings: {
    'lobby': { label: 'Grand Lobby', sweepId: 'abc123' },
    'restaurant': { label: 'The Lighthouse Restaurant', sweepId: 'def456' },
    'deluxe_room': { label: 'Deluxe Harbour Room', sweepId: 'ghi789' },
    'suite': { label: 'Panorama Suite', sweepId: 'jkl012' },
    'rooftop': { label: 'Rooftop Terrace', sweepId: 'mno345' },
    'wellness': { label: 'Wellness Centre', sweepId: 'pqr678' }
  },
  tenants: [
    { id: 'demo-tenant-001', name: 'Harbour View Hotel' }
  ],
  analytics: {
    conversations30d: 847,
    bookings30d: 127,
    conversionRate: 15,
    avgDuration: 245,
    totalVisitors: 3420,
    spacesShown: 2150,
    popularQuestions: [
      { content: 'Can you show me the rooms?', count: 156 },
      { content: 'What are the prices?', count: 134 },
      { content: 'Do you have a restaurant?', count: 98 },
      { content: 'Is parking available?', count: 87 },
      { content: 'What time is check-in?', count: 76 },
      { content: 'Do you have a pool?', count: 65 },
      { content: 'Can I see the suite?', count: 58 },
      { content: 'What is included in the price?', count: 52 },
      { content: 'How far is the airport?', count: 41 },
      { content: 'Do you allow pets?', count: 34 }
    ],
    roomPerformance: [
      { room: 'Deluxe Harbour Room', shown: 423, clicked: 67 },
      { room: 'The Lighthouse Restaurant', shown: 387, clicked: 45 },
      { room: 'Panorama Suite', shown: 312, clicked: 89 },
      { room: 'Grand Lobby', shown: 298, clicked: 12 },
      { room: 'Rooftop Terrace', shown: 245, clicked: 34 },
      { room: 'Wellness Centre', shown: 189, clicked: 23 }
    ],
    leads: [
      { guest_name: 'Emma Thompson', guest_email: 'emma.t@example.com', guest_phone: '+44 7700 900123', created_at: '2026-04-11T14:32:00Z', had_booking_click: true },
      { guest_name: 'Marcus Lindberg', guest_email: 'marcus.l@example.com', guest_phone: '+46 70 123 4567', created_at: '2026-04-10T09:15:00Z', had_booking_click: true },
      { guest_name: 'Sophie Müller', guest_email: 'sophie.m@example.com', guest_phone: '+49 170 1234567', created_at: '2026-04-09T16:48:00Z', had_booking_click: false },
      { guest_name: 'James Wilson', guest_email: 'james.w@example.com', guest_phone: '+1 555 0123', created_at: '2026-04-08T11:22:00Z', had_booking_click: true },
      { guest_name: 'Isabelle Dupont', guest_email: 'isabelle.d@example.com', guest_phone: '+33 6 12 34 56 78', created_at: '2026-04-07T08:05:00Z', had_booking_click: false },
      { guest_name: 'Henrik Petersen', guest_email: 'henrik.p@example.com', guest_phone: '+45 20 12 34 56', created_at: '2026-04-06T19:30:00Z', had_booking_click: true },
      { guest_name: 'Maria Garcia', guest_email: 'maria.g@example.com', guest_phone: '+34 612 345 678', created_at: '2026-04-05T13:17:00Z', had_booking_click: false },
      { guest_name: 'Oliver Hansen', guest_email: 'oliver.h@example.com', guest_phone: '+45 30 98 76 54', created_at: '2026-04-04T10:42:00Z', had_booking_click: true },
      { guest_name: 'Charlotte Brown', guest_email: 'charlotte.b@example.com', guest_phone: '+44 7911 123456', created_at: '2026-04-03T15:55:00Z', had_booking_click: true },
      { guest_name: 'Lukas Schmidt', guest_email: 'lukas.s@example.com', guest_phone: '+49 151 12345678', created_at: '2026-04-02T07:30:00Z', had_booking_click: false }
    ]
  },
  usage: {
    minutesUsed: 342,
    quotaMinutes: 1000
  },
  subscription: {
    status: 'active',
    nextBillingDate: '2026-05-01T00:00:00Z'
  },
  scrapeStatus: null,
  scrapeMessage: null
};

/* Generate demo conversations */
function generateDemoConversations() {
  const names = ['Emma Thompson', 'Marcus Lindberg', 'Sophie Müller', 'James Wilson', 'Isabelle Dupont', 'Henrik Petersen', 'Maria Garcia', 'Oliver Hansen', 'Charlotte Brown', 'Lukas Schmidt'];
  const questions = ['Can you show me the rooms?', 'What are the prices?', 'Do you have a restaurant?', 'Is parking available?', 'Can I see the suite?'];
  const rooms = ['lobby', 'restaurant', 'deluxe_room', 'suite', 'rooftop', 'wellness'];
  const convos = [];
  for (let i = 0; i < 50; i++) {
    const converted = Math.random() > 0.6;
    const dur = Math.floor(Math.random() * 400) + 60;
    const daysAgo = Math.floor(Math.random() * 30);
    const shownRooms = [];
    const numRooms = Math.floor(Math.random() * 3) + 1;
    for (let r = 0; r < numRooms; r++) {
      shownRooms.push(rooms[Math.floor(Math.random() * rooms.length)]);
    }
    convos.push({
      id: 'conv-' + (1000 + i),
      visitorName: names[i % names.length],
      date: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      duration: dur,
      converted: converted,
      spacesShown: [...new Set(shownRooms)],
      messageCount: Math.floor(Math.random() * 12) + 4
    });
  }
  return convos.sort((a, b) => new Date(b.date) - new Date(a.date));
}

const DEMO_CONVERSATIONS = generateDemoConversations();

/* Generate demo messages for a conversation */
function generateDemoMessages(convId) {
  const pairs = [
    ['Hi! Can you show me around the hotel?', 'Welcome to Harbour View Hotel! I would love to show you around. We have a beautiful waterfront property with stunning harbour views. Would you like to start with our rooms, the restaurant, or the rooftop terrace?'],
    ['What room types do you have?', 'We have four room categories: Standard rooms (18m², city view, from 129 EUR), Superior rooms (24m², partial harbour view, from 179 EUR), Deluxe rooms (32m², full harbour view with balcony, from 249 EUR), and our signature Panorama Suite (48m², panoramic harbour view with separate living area, from 379 EUR). All rates include breakfast. Shall I show you any of these?'],
    ['Show me the deluxe room', 'Here is our Deluxe Harbour Room — a spacious 32m² room with a private balcony overlooking the harbour. The room features a king-size bed, a sitting area, and a marble bathroom with rain shower. Would you like to see the suite as well?'],
    ['What about dining?', 'Our Lighthouse Restaurant offers fine dining with panoramic harbour views, open daily from 7:00 to 22:00. We also have the Harbour Bar for cocktails and light bites, open from 16:00 to midnight. Let me show you the restaurant.'],
    ['How do I book?', 'You can book directly through our website or I can redirect you to our booking page. We currently have availability for the dates you are interested in. Would you like me to take you to the booking page?'],
    ['Yes please!', 'Let me direct you to our booking page where you can select your dates and preferred room type. Thank you for your interest in Harbour View Hotel — we look forward to welcoming you!']
  ];
  const messages = [];
  const numPairs = Math.min(pairs.length, Math.floor(Math.random() * 4) + 2);
  for (let i = 0; i < numPairs; i++) {
    messages.push({ role: 'user', content: pairs[i][0] });
    messages.push({ role: 'assistant', content: pairs[i][1] });
  }
  return messages;
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
app.post('/client/demo/upload-file', upload.single('file'), (req, res) => {
  res.json({ ok: true, wordCount: 250 });
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
