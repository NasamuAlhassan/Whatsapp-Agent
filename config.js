require('dotenv').config();

const config = Object.freeze({
  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  USER_NAME: process.env.USER_NAME || 'User',
  USER_PHONE: process.env.USER_PHONE || '',
  DIGEST_INTERVAL_MINUTES: parseInt(process.env.DIGEST_INTERVAL_MINUTES || '15', 10),
  QUIET_START: process.env.QUIET_START || '23:00',
  QUIET_END: process.env.QUIET_END || '06:00',
  PORT: parseInt(process.env.PORT || '3000', 10),
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || '',
});

module.exports = config;
