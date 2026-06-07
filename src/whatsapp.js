const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const database = require('./database');
const buffer = require('./buffer');
const analyzer = require('./analyzer');

const MAX_RETRIES = 5;
let retryCount = 0;
let suppressLogs = false;

function ts() { return new Date().toTimeString().slice(0, 8); }
function log(...args) { if (!suppressLogs) console.log(...args); }

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth',
  }),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function msgPreview(msg) {
  if (!msg) return '';
  const t = msg.type;
  if (t === 'image')    return '📷 Photo';
  if (t === 'video')    return '🎥 Video';
  if (t === 'audio' || t === 'ptt') return '🎵 Audio';
  if (t === 'document') return '📄 Document';
  if (t === 'sticker')  return '🌟 Sticker';
  if (t === 'location') return '📍 Location';
  return msg.body || '';
}

// ── QR ───────────────────────────────────────────────────────────────────────

client.on('qr', async (qr) => {
  console.clear();
  console.log('📱 QR ready — scan in the dashboard or here:\n');
  qrcode.generate(qr, { small: true });

  try {
    const dataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
    const server = require('./server');
    server.broadcast({ type: 'qr', data: dataUrl });
  } catch (err) {
    console.error('[whatsapp] QR broadcast error:', err.message);
  }

  suppressLogs = true;
  setTimeout(() => { suppressLogs = false; }, 3000);
});

// ── Authenticated (QR scanned, server verifying) ──────────────────────────────

client.on('authenticated', () => {
  suppressLogs = false;
  console.log(`[${ts()}] 🔐 WhatsApp authenticated — syncing chats...`);
  try {
    const server = require('./server');
    server.broadcast({ type: 'authenticated' });
  } catch {}
});

// ── Auth failure ──────────────────────────────────────────────────────────────

client.on('auth_failure', (msg) => {
  console.error(`[${ts()}] ❌ Auth failed: ${msg}`);
  try {
    const server = require('./server');
    server.broadcast({ type: 'auth_failure', data: String(msg) });
  } catch {}
});

// ── Ready ────────────────────────────────────────────────────────────────────

client.on('ready', async () => {
  retryCount = 0;
  suppressLogs = false;
  console.log(`[${ts()}] ✅ WhatsApp connected`);

  const server = require('./server');
  server.broadcast({ type: 'status', data: { connected: true } });
  server.broadcast({ type: 'qr_done' });
  setTimeout(() => server.broadcast({ type: 'status', data: { connected: true } }), 2000);

  const telegram = require('./telegram');
  telegram.setConnected(true);

  // Load and broadcast all chats, then kick off the first AI digest
  setTimeout(async () => {
    await broadcastChats();
    setTimeout(() => buffer.runDigestNow(), 8000);
  }, 4000);
});

// ── New message ───────────────────────────────────────────────────────────────

client.on('message', async (msg) => {
  try {
    let chatName = '';
    let isGroup = false;
    let isChannel = false;
    let chatId = '';

    try {
      const chat = await msg.getChat();
      chatName  = chat.name || chat.id.user || 'Unknown';
      isGroup   = chat.isGroup;
      isChannel = chat.isChannel || false;
      chatId    = chat.id._serialized;
    } catch {
      chatName = msg.from || 'Unknown';
      chatId   = msg.from || '';
    }

    const message = {
      id:           msg.id._serialized || String(Date.now()),
      body:         msg.body || '',
      senderName:   msg._data?.notifyName || msg.author || msg.from || 'Unknown',
      senderNumber: msg.from || '',
      chatName,
      chatId,
      isGroup,
      isChannel,
      fromMe:       false,
      mentionedIds: msg.mentionedIds || [],
      hasQuotedMsg: msg.hasQuotedMsg || false,
      timestamp:    msg.timestamp ? msg.timestamp * 1000 : Date.now(),
      type:         msg.type || 'chat',
    };

    database.saveMessage(message);
    buffer.addMessage(message);
    analyzer.classifyUrgency(message).catch((err) =>
      console.error(`[${ts()}] [whatsapp] classifyUrgency error: ${err.message}`)
    );

    const server = require('./server');
    server.broadcast({ type: 'message', data: message });
  } catch (err) {
    console.error(`[${ts()}] [whatsapp] message handler error: ${err.message}`);
  }
});

// ── Disconnect ────────────────────────────────────────────────────────────────

client.on('disconnected', async (reason) => {
  console.log(`[${ts()}] [whatsapp] Disconnected: ${reason}`);

  const server = require('./server');
  server.broadcast({ type: 'status', data: { connected: false } });

  const telegram = require('./telegram');
  telegram.setConnected(false);

  if (retryCount >= MAX_RETRIES) {
    console.error(`[${ts()}] [whatsapp] Max reconnect attempts reached. Stopping.`);
    return;
  }

  retryCount++;
  console.log(`[${ts()}] [whatsapp] Reconnect attempt ${retryCount}/${MAX_RETRIES} in 5s…`);
  setTimeout(async () => {
    try { await client.initialize(); }
    catch (err) { console.error(`[${ts()}] [whatsapp] Reconnect failed: ${err.message}`); }
  }, 5000);
});

// ── Chat helpers (exported) ───────────────────────────────────────────────────

async function broadcastChats() {
  try {
    const server = require('./server');
    const chats = await client.getChats();
    const chatData = chats.slice(0, 40).map(c => ({
      id:          c.id._serialized,
      name:        c.name || c.id.user || 'Unknown',
      isGroup:     c.isGroup || false,
      isChannel:   c.isChannel || false,
      unreadCount: c.unreadCount || 0,
      timestamp:   c.timestamp ? c.timestamp * 1000 : 0,
      lastMessage: c.lastMessage ? {
        body:      msgPreview(c.lastMessage),
        timestamp: c.lastMessage.timestamp ? c.lastMessage.timestamp * 1000 : 0,
        fromMe:    c.lastMessage.fromMe || false,
      } : null,
    }));
    chatData.sort((a, b) => b.timestamp - a.timestamp);
    server.broadcast({ type: 'chats', data: chatData });
    console.log(`[${ts()}] 📋 Broadcast ${chatData.length} chats to dashboard`);
  } catch (err) {
    console.error(`[${ts()}] [whatsapp] broadcastChats error: ${err.message}`);
  }
}

async function getChats() {
  const chats = await client.getChats();
  return chats.slice(0, 40).map(c => ({
    id:          c.id._serialized,
    name:        c.name || c.id.user || 'Unknown',
    isGroup:     c.isGroup || false,
    isChannel:   c.isChannel || false,
    unreadCount: c.unreadCount || 0,
    timestamp:   c.timestamp ? c.timestamp * 1000 : 0,
    lastMessage: c.lastMessage ? {
      body:      msgPreview(c.lastMessage),
      timestamp: c.lastMessage.timestamp ? c.lastMessage.timestamp * 1000 : 0,
      fromMe:    c.lastMessage.fromMe || false,
    } : null,
  })).sort((a, b) => b.timestamp - a.timestamp);
}

async function getChatMessages(chatId, limit = 50) {
  const chat = await client.getChatById(chatId);
  await chat.fetchMessages({ limit });
  const messages = await chat.fetchMessages({ limit });
  return messages.map(m => ({
    id:         m.id._serialized,
    body:       msgPreview(m),
    fromMe:     m.fromMe || false,
    senderName: m.fromMe ? 'You' : (m._data?.notifyName || m.author?.split('@')[0] || 'Unknown'),
    timestamp:  m.timestamp ? m.timestamp * 1000 : Date.now(),
    type:       m.type || 'chat',
  }));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

async function start() {
  try { await client.initialize(); }
  catch (err) {
    console.error(`[${ts()}] [whatsapp] initialize failed: ${err.message}`);
    throw err;
  }
}

async function destroy() {
  try { await client.destroy(); } catch {}
}

module.exports = { start, destroy, getChats, getChatMessages, broadcastChats };
