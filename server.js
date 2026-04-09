const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

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
  console.log(`Admin Dashboard running on port ${PORT}`);
  console.log(`Database: ${pool ? 'connected' : 'not configured'}`);
});
