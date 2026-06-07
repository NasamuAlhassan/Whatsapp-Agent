const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'agent.db');
let db = null;

function save() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function init() {
  const SQL = await initSqlJs();
  let fileData = null;
  try { fileData = fs.readFileSync(DB_PATH); } catch {}
  db = fileData ? new SQL.Database(fileData) : new SQL.Database();

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      body TEXT,
      sender_name TEXT,
      sender_number TEXT,
      chat_name TEXT,
      is_group INTEGER,
      is_channel INTEGER,
      is_urgent INTEGER DEFAULT 0,
      timestamp INTEGER
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_name TEXT,
      summary_text TEXT,
      urgent_count INTEGER,
      task_count INTEGER,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT,
      deadline TEXT,
      source_group TEXT,
      source_sender TEXT,
      completed INTEGER DEFAULT 0,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT,
      category TEXT,
      source_group TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS telegram_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      chat_id TEXT,
      created_at INTEGER
    );
  `);

  save();
}

function saveMessage(msg) {
  run(
    `INSERT OR IGNORE INTO messages
       (id, body, sender_name, sender_number, chat_name, is_group, is_channel, is_urgent, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [msg.id, msg.body, msg.senderName, msg.senderNumber, msg.chatName,
     msg.isGroup ? 1 : 0, msg.isChannel ? 1 : 0, msg.timestamp]
  );
}

function markUrgent(messageId) {
  run(`UPDATE messages SET is_urgent = 1 WHERE id = ?`, [messageId]);
}

function saveSummary(chatName, result) {
  run(
    `INSERT INTO summaries (chat_name, summary_text, urgent_count, task_count, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [chatName, result.summary || '', (result.urgentItems || []).length,
     (result.tasks || []).length, Date.now()]
  );
}

function saveTasks(tasksArray) {
  db.run('BEGIN');
  try {
    for (const task of tasksArray) {
      db.run(
        `INSERT INTO tasks (text, deadline, source_group, source_sender, completed, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
        [task.text || '', task.deadline || null, task.sourceGroup || null,
         task.sourceSender || null, Date.now()]
      );
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  save();
}

function saveNews(newsArray) {
  db.run('BEGIN');
  try {
    for (const item of newsArray) {
      db.run(
        `INSERT INTO news (text, category, source_group, created_at)
         VALUES (?, ?, ?, ?)`,
        [item.text || '', item.category || 'General', item.sourceGroup || null, Date.now()]
      );
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  save();
}

function saveTelegramChatId(chatId) {
  run(
    `INSERT INTO telegram_config (id, chat_id, created_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, created_at = excluded.created_at`,
    [chatId, Date.now()]
  );
}

function getTelegramChatId() {
  const row = get(`SELECT chat_id FROM telegram_config WHERE id = 1`);
  return row ? row.chat_id : null;
}

function getRecentMessages(limit) {
  return all(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?`, [limit]);
}

function getSummaries(limit) {
  return all(`SELECT * FROM summaries ORDER BY created_at DESC LIMIT ?`, [limit]);
}

function getTasks(onlyIncomplete) {
  return onlyIncomplete
    ? all(`SELECT * FROM tasks WHERE completed = 0 ORDER BY created_at DESC`)
    : all(`SELECT * FROM tasks ORDER BY created_at DESC`);
}

function getNews(limit) {
  return all(`SELECT * FROM news ORDER BY created_at DESC LIMIT ?`, [limit]);
}

function markTaskComplete(id) {
  run(`UPDATE tasks SET completed = 1 WHERE id = ?`, [id]);
}

function getMessageCountToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const row = get(`SELECT COUNT(*) as count FROM messages WHERE timestamp >= ?`, [startOfDay.getTime()]);
  return row ? row.count : 0;
}

function close() {
  if (db) {
    save();
    db.close();
    db = null;
  }
}

module.exports = {
  init,
  saveMessage,
  markUrgent,
  saveSummary,
  saveTasks,
  saveNews,
  saveTelegramChatId,
  getTelegramChatId,
  getRecentMessages,
  getSummaries,
  getTasks,
  getNews,
  markTaskComplete,
  getMessageCountToday,
  close,
};
