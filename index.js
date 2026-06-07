// ─── Startup — ORDER IS CRITICAL ─────────────────────────────────────────────
// 1. database   — SQLite must be ready before anything else
// 2. telegram   — safe to poll now that DB is ready
// 3. server     — Express + WebSocket
// 4. whatsapp   — WhatsApp session last

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

async function main() {
  // Step 1: Database
  console.log(`[${ts()}] Starting database...`);
  try {
    const database = require('./src/database');
    await database.init();
    console.log(`[${ts()}] ✅ Database initialized`);
  } catch (err) {
    console.error(`[${ts()}] ❌ Database failed: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Telegram
  console.log(`[${ts()}] Starting Telegram bot...`);
  try {
    const telegram = require('./src/telegram');
    console.log(`[${ts()}] ✅ Telegram bot started`);
  } catch (err) {
    console.error(`[${ts()}] ❌ Telegram failed: ${err.message}`);
    process.exit(1);
  }

  // Step 3: Server
  console.log(`[${ts()}] Starting Express server...`);
  try {
    const config = require('./config');
    const server = require('./src/server');
    await server.start();
    const authNote = config.DASHBOARD_PASSWORD ? '' : ' (⚠️  no password set)';
    console.log(`[${ts()}] ✅ Server running on http://localhost:${config.PORT}${authNote}`);
    if (!config.DASHBOARD_PASSWORD) {
      console.warn(`[${ts()}] ⚠️  DASHBOARD_PASSWORD not set — dashboard is unprotected.`);
    }
  } catch (err) {
    console.error(`[${ts()}] ❌ Server failed: ${err.message}`);
    process.exit(1);
  }

  // Start digest scheduler (reads config.DIGEST_INTERVAL_MINUTES)
  const buffer = require('./src/buffer');
  buffer.startDigestScheduler();

  // Step 4: WhatsApp
  console.log(`[${ts()}] Starting WhatsApp client...`);
  try {
    const whatsapp = require('./src/whatsapp');
    await whatsapp.start();
  } catch (err) {
    console.error(`[${ts()}] ❌ WhatsApp initialization failed: ${err.message}`);
    // Not fatal — WhatsApp will retry on disconnect
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n[${ts()}] ${signal} received — shutting down cleanly...`);

  const buffer = require('./src/buffer');
  buffer.stopDigestScheduler();

  try {
    const whatsapp = require('./src/whatsapp');
    await whatsapp.destroy();
  } catch {
    // Ignore
  }

  try {
    const database = require('./src/database');
    database.close();
  } catch {
    // Ignore
  }

  console.log(`[${ts()}] Goodbye.`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error(`[${ts()}] Unhandled startup error: ${err.message}`);
  process.exit(1);
});
