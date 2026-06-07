const http    = require('http');
const path    = require('path');
const express = require('express');
const WebSocket = require('ws');
const config  = require('../config');
const database = require('./database');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());

// ── Auth ──────────────────────────────────────────────────────────────────────

function basicAuth(req, res, next) {
  if (!config.DASHBOARD_PASSWORD) return next();
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="WA Agent"');
    return res.status(401).send('Unauthorized');
  }
  const [, pass] = Buffer.from(authHeader.slice(6), 'base64').toString().split(':');
  if (pass !== config.DASHBOARD_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="WA Agent"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

// ── Static ────────────────────────────────────────────────────────────────────

app.get('/', basicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── State ─────────────────────────────────────────────────────────────────────

let waConnected   = false;
let lastDigestTime = null;

// ── API: Status ───────────────────────────────────────────────────────────────

app.get('/api/status', basicAuth, (req, res) => {
  try {
    const intervalMs  = config.DIGEST_INTERVAL_MINUTES * 60 * 1000;
    const nextDigest  = lastDigestTime
      ? new Date(lastDigestTime + intervalMs).toLocaleTimeString()
      : new Date(Date.now() + intervalMs).toLocaleTimeString();
    res.json({
      connected:        waConnected,
      lastDigest:       lastDigestTime ? new Date(lastDigestTime).toLocaleTimeString() : null,
      messageCountToday: database.getMessageCountToday(),
      nextDigest,
      userName:         config.USER_NAME,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: Chats ────────────────────────────────────────────────────────────────

app.get('/api/chats', basicAuth, async (req, res) => {
  try {
    const wa = require('./whatsapp');
    const chats = await wa.getChats();
    res.json(chats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats/:chatId/messages', basicAuth, async (req, res) => {
  try {
    const wa = require('./whatsapp');
    const messages = await wa.getChatMessages(decodeURIComponent(req.params.chatId));
    res.json(messages);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: Data ─────────────────────────────────────────────────────────────────

app.get('/api/summaries', basicAuth, (req, res) => {
  try { res.json(database.getSummaries(20)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks', basicAuth, (req, res) => {
  try {
    const onlyIncomplete = req.query.incomplete === 'true';
    res.json(database.getTasks(onlyIncomplete));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/news', basicAuth, (req, res) => {
  try { res.json(database.getNews(20)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/messages', basicAuth, (req, res) => {
  try { res.json(database.getRecentMessages(100)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/:id/complete', basicAuth, (req, res) => {
  try { database.markTaskComplete(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ask', basicAuth, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });
    const analyzer = require('./analyzer');
    const answer = await analyzer.askQuestion(question);
    res.json({ answer });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', data: { connected: waConnected } }));
});

function broadcast(eventObject) {
  const payload = JSON.stringify(eventObject);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch {}
    }
  }
  if (eventObject.type === 'status')  waConnected   = eventObject.data.connected;
  if (eventObject.type === 'digest')  lastDigestTime = Date.now();
}

// Heartbeat every 10 s so dashboard never shows stale status
setInterval(() => broadcast({ type: 'status', data: { connected: waConnected } }), 10000);

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function start() {
  return new Promise((resolve, reject) => {
    server.listen(config.PORT, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function close() { return new Promise((resolve) => server.close(resolve)); }

module.exports = { start, close, broadcast };
