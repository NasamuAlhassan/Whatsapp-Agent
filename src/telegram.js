const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const database = require('./database');

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, {
  polling: { autoStart: !!config.TELEGRAM_BOT_TOKEN },
});

// Suppress EFATAL network errors (e.g. HF Spaces can't reach api.telegram.org)
bot.on('polling_error', (err) => {
  if (err.code === 'EFATAL' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') return;
  console.error(`[telegram] polling_error: ${err.message}`);
});

let waConnected = false;
let lastDigestTime = null;
let pendingDigest = null;
let quietTimeout = null;

// ─── Quiet Hours ─────────────────────────────────────────────────────────────

function parseTime(str) {
  const [h, m] = str.split(':').map(Number);
  return { h, m };
}

function isQuietHours() {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const start = parseTime(config.QUIET_START);
  const end = parseTime(config.QUIET_END);
  const startMinutes = start.h * 60 + start.m;
  const endMinutes = end.h * 60 + end.m;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Spans midnight
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function msUntilTime(timeStr) {
  const { h, m } = parseTime(timeStr);
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

// ─── MarkdownV2 Escaping ─────────────────────────────────────────────────────

function escapeMarkdown(text) {
  if (text == null) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ─── Chat ID Helpers ──────────────────────────────────────────────────────────

function getChatId() {
  return database.getTelegramChatId();
}

async function safeSend(chatId, text, options = {}) {
  try {
    await bot.sendMessage(chatId, text, options);
  } catch (err) {
    console.error(`[telegram] sendMessage failed: ${err.message}`);
  }
}

// ─── Bot Commands ─────────────────────────────────────────────────────────────

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);
  database.saveTelegramChatId(chatId);
  await safeSend(
    chatId,
    `✅ Delivery activated\\. You'll receive digests every ${escapeMarkdown(config.DIGEST_INTERVAL_MINUTES)} minutes\\.`,
    { parse_mode: 'MarkdownV2' }
  );
  console.log(`[${ts()}] [telegram] /start from chat ${chatId} — chat ID saved`);
});

bot.onText(/\/status/, async (msg) => {
  const chatId = String(msg.chat.id);
  const connected = waConnected ? 'Connected ✅' : 'Disconnected ❌';
  const lastDigest = lastDigestTime
    ? new Date(lastDigestTime).toLocaleTimeString()
    : 'None yet';
  const countToday = database.getMessageCountToday();
  const intervalMs = config.DIGEST_INTERVAL_MINUTES * 60 * 1000;
  const nextMs = lastDigestTime ? lastDigestTime + intervalMs : Date.now() + intervalMs;
  const nextDigest = new Date(nextMs).toLocaleTimeString();

  const text =
    `🤖 *Agent Status*\n` +
    `WhatsApp: ${escapeMarkdown(connected)}\n` +
    `Last digest: ${escapeMarkdown(lastDigest)}\n` +
    `Messages today: ${escapeMarkdown(String(countToday))}\n` +
    `Next digest: ${escapeMarkdown(nextDigest)}`;

  await safeSend(chatId, text, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/tasks/, async (msg) => {
  const chatId = String(msg.chat.id);
  const tasks = database.getTasks(true);
  if (tasks.length === 0) {
    await safeSend(chatId, '📋 No pending tasks\\.', { parse_mode: 'MarkdownV2' });
    return;
  }
  const lines = tasks.map((t, i) => {
    const deadline = t.deadline ? ` — Due: ${t.deadline}` : '';
    return `${i + 1}\\. ${escapeMarkdown(t.text)}${escapeMarkdown(deadline)}`;
  });
  await safeSend(chatId, `📋 *Pending Tasks*\n${lines.join('\n')}`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/help/, async (msg) => {
  const chatId = String(msg.chat.id);
  const text =
    `🤖 *WA Agent Commands*\n\n` +
    `/start \\- Activate digest delivery\n` +
    `/status \\- Show agent status\n` +
    `/tasks \\- List pending tasks\n` +
    `/help \\- Show this help message`;
  await safeSend(chatId, text, { parse_mode: 'MarkdownV2' });
});

// ─── Digest Formatting ────────────────────────────────────────────────────────

function formatDigest(digestPayload) {
  const now = new Date().toTimeString().slice(0, 5);
  const nextTime = new Date(
    Date.now() + config.DIGEST_INTERVAL_MINUTES * 60 * 1000
  ).toTimeString().slice(0, 5);

  const dms = digestPayload.filter((d) => d.type === 'dm');
  const groups = digestPayload.filter((d) => d.type !== 'dm');

  let text = `━━━━━━━━━━━━━━━━━━━━━━\n🤖 *WA DIGEST* — ${escapeMarkdown(now)}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // DM Section
  text += `📩 *DIRECT MESSAGES*\n───────────────────\n`;
  if (dms.length === 0) {
    text += `_No direct messages_\n`;
  } else {
    for (const dm of dms) {
      text += `👤 *${escapeMarkdown(dm.chatName)}* — ${escapeMarkdown(String(dm.messageCount))} message${dm.messageCount !== 1 ? 's' : ''}\n`;
    }
  }

  text += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  text += `👥 *GROUPS & CHANNELS*\n───────────────────\n`;

  const groupSections = [];

  if (groups.length === 0) {
    groupSections.push('_No group activity_');
  } else {
    for (const g of groups) {
      let section = `\n📌 *${escapeMarkdown(g.chatName)}* _\\(${escapeMarkdown(String(g.messageCount))} messages\\)_\n`;
      section += `${escapeMarkdown(g.summary)}\n`;

      if (g.urgentItems && g.urgentItems.length > 0) {
        for (const item of g.urgentItems) {
          const deadline = item.deadline ? ` ${escapeMarkdown(item.deadline)}` : '';
          section += `\n⚠️ Urgent: ${escapeMarkdown(item.text)}${deadline}\n`;
        }
      }
      if (g.tasks && g.tasks.length > 0) {
        for (const task of g.tasks) {
          section += `✅ Task: ${escapeMarkdown(task.text)}\n`;
        }
      }
      section += `\n───────────────────`;
      groupSections.push(section);
    }
  }

  // Split into parts respecting the 4096 char Telegram limit
  const parts = [];
  let current = text;

  for (const section of groupSections) {
    if ((current + section).length > 4000) {
      parts.push(current);
      current = section;
    } else {
      current += section;
    }
  }

  const footer = `\n\n_${escapeMarkdown(config.DIGEST_INTERVAL_MINUTES)}\\-min digest • Next at ${escapeMarkdown(nextTime)}_`;
  if ((current + footer).length > 4000) {
    parts.push(current);
    parts.push(footer);
  } else {
    current += footer;
    parts.push(current);
  }

  return parts;
}

async function sendDigest(digestPayload, bypassQuietCheck = false) {
  const chatId = getChatId();
  if (!chatId) {
    console.warn(`[${ts()}] [telegram] No chat ID — cannot send digest`);
    return;
  }

  if (!bypassQuietCheck && isQuietHours()) {
    pendingDigest = digestPayload;
    console.log(`[${ts()}] 🔕 Quiet hours active — digest queued for ${config.QUIET_END}`);

    if (quietTimeout) clearTimeout(quietTimeout);
    const delay = msUntilTime(config.QUIET_END);
    quietTimeout = setTimeout(() => {
      if (pendingDigest) {
        sendDigest(pendingDigest, true);
        pendingDigest = null;
        quietTimeout = null;
      }
    }, delay);
    return;
  }

  lastDigestTime = Date.now();
  const parts = formatDigest(digestPayload);

  for (let i = 0; i < parts.length; i++) {
    await safeSend(chatId, parts[i], { parse_mode: 'MarkdownV2' });
    if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
}

async function sendUrgentAlert(message) {
  const chatId = getChatId();
  if (!chatId) return;

  const text =
    `🚨 *URGENT — ${escapeMarkdown(message.chatName)}*\n\n` +
    `From: ${escapeMarkdown(message.senderName)}\n` +
    `"${escapeMarkdown(message.body)}"\n\n` +
    `⏰ ${escapeMarkdown(new Date(message.timestamp).toLocaleTimeString())}`;

  await safeSend(chatId, text, { parse_mode: 'MarkdownV2' });
}

async function sendTaskUpdate(task) {
  const chatId = getChatId();
  if (!chatId) return;

  const deadline = task.deadline || 'Not specified';
  const source = task.sourceGroup || 'Unknown';

  const text =
    `📋 *New Task Extracted*\n` +
    `${escapeMarkdown(task.text)}\n` +
    `📅 Deadline: ${escapeMarkdown(deadline)}\n` +
    `📍 Source: ${escapeMarkdown(source)}`;

  await safeSend(chatId, text, { parse_mode: 'MarkdownV2' });
}

function setConnected(status) {
  waConnected = status;
}

// Warn on startup if no chat ID is saved
const savedChatId = database.getTelegramChatId();
if (!savedChatId) {
  console.warn(
    '⚠️  No Telegram chat ID saved. Open Telegram, find your bot, and send /start to activate delivery.'
  );
}

module.exports = { sendDigest, sendUrgentAlert, sendTaskUpdate, setConnected, bot };
