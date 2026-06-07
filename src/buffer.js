const config = require('../config');
const analyzer = require('./analyzer');
const notifier = require('./notifier');

const buffer = new Map();
let digestTimer = null;

function addMessage(message) {
  const key = message.chatName;
  if (!buffer.has(key)) {
    let type = 'dm';
    if (message.isChannel) type = 'channel';
    else if (message.isGroup) type = 'group';
    buffer.set(key, { type, messages: [] });
  }
  buffer.get(key).messages.push(message);
}

async function runDigest() {
  if (buffer.size === 0) return; // Nothing to process — skip silently

  // Snapshot and clear immediately so new messages go to a fresh buffer
  const snapshot = new Map(buffer);
  buffer.clear();

  try {
    const result = await analyzer.buildDigest(snapshot);

    const telegram = require('./telegram');
    await telegram.sendDigest(result);
    notifier.notifyDigest(result);

    const server = require('./server');
    server.broadcast({ type: 'digest', data: result });
  } catch (err) {
    console.error(`[${new Date().toTimeString().slice(0, 8)}] [buffer] Digest run failed: ${err.message}`);
  }
}

function startDigestScheduler() {
  const intervalMs = config.DIGEST_INTERVAL_MINUTES * 60 * 1000;
  digestTimer = setInterval(runDigest, intervalMs);
  console.log(
    `[${new Date().toTimeString().slice(0, 8)}] [buffer] Digest scheduler started — every ${config.DIGEST_INTERVAL_MINUTES} min`
  );
}

function stopDigestScheduler() {
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
}

module.exports = { addMessage, startDigestScheduler, stopDigestScheduler };
