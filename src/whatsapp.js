const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const database = require('./database');
const buffer = require('./buffer');
const analyzer = require('./analyzer');

const MAX_RETRIES = 5;
let retryCount = 0;
let suppressLogs = false;

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function log(...args) {
  if (!suppressLogs) console.log(...args);
}

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

client.on('qr', (qr) => {
  console.clear();
  console.log('📱 QR ready — scan in the dashboard or here:\n');
  qrcode.generate(qr, { small: true });

  // Broadcast QR to dashboard over WebSocket
  try {
    const server = require('./server');
    server.broadcast({ type: 'qr', data: qr });
  } catch {}

  suppressLogs = true;
  setTimeout(() => { suppressLogs = false; }, 3000);
});

client.on('ready', () => {
  retryCount = 0;
  console.log(`[${ts()}] ✅ WhatsApp connected`);

  const server = require('./server');
  server.broadcast({ type: 'status', data: { connected: true } });

  const telegram = require('./telegram');
  telegram.setConnected(true);
});

client.on('message', async (msg) => {
  try {
    let chatName = '';
    let isGroup = false;
    let isChannel = false;

    try {
      const chat = await msg.getChat();
      chatName = chat.name || chat.id.user || 'Unknown';
      isGroup = chat.isGroup;
      isChannel = chat.isChannel || false;
    } catch {
      chatName = msg.from || 'Unknown';
    }

    const message = {
      id: msg.id._serialized || msg.id.id || String(Date.now()),
      body: msg.body || '',
      senderName: msg._data?.notifyName || msg.author || msg.from || 'Unknown',
      senderNumber: msg.from || '',
      chatName,
      isGroup,
      isChannel,
      mentionedIds: msg.mentionedIds || [],
      hasQuotedMsg: msg.hasQuotedMsg || false,
      timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
    };

    database.saveMessage(message);
    buffer.addMessage(message);
    analyzer.classifyUrgency(message).catch((err) => {
      console.error(`[${ts()}] [whatsapp] classifyUrgency error: ${err.message}`);
    });

    const server = require('./server');
    server.broadcast({ type: 'message', data: message });
  } catch (err) {
    console.error(`[${ts()}] [whatsapp] message handler error: ${err.message}`);
  }
});

client.on('disconnected', async (reason) => {
  console.log(`[${ts()}] [whatsapp] Disconnected: ${reason}`);

  const server = require('./server');
  server.broadcast({ type: 'status', data: { connected: false } });

  const telegram = require('./telegram');
  telegram.setConnected(false);

  if (retryCount >= MAX_RETRIES) {
    console.error(`[${ts()}] [whatsapp] FATAL: Max reconnect attempts (${MAX_RETRIES}) reached. Stopping.`);
    return;
  }

  retryCount++;
  console.log(`[${ts()}] [whatsapp] Reconnect attempt ${retryCount}/${MAX_RETRIES} in 5s...`);
  setTimeout(async () => {
    try {
      await client.initialize();
    } catch (err) {
      console.error(`[${ts()}] [whatsapp] Reconnect initialize failed: ${err.message}`);
    }
  }, 5000);
});

async function start() {
  try {
    await client.initialize();
  } catch (err) {
    console.error(`[${ts()}] [whatsapp] initialize failed: ${err.message}`);
    throw err;
  }
}

async function destroy() {
  try {
    await client.destroy();
  } catch {
    // Ignore destroy errors during shutdown
  }
}

module.exports = { start, destroy };
