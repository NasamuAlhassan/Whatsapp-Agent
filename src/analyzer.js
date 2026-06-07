const Groq = require('groq-sdk');
const config = require('../config');
const database = require('./database');
const notifier = require('./notifier');

const groq = new Groq({ apiKey: config.GROQ_API_KEY });

const CORE_URGENT_KEYWORDS = [
  'assignment', 'due', 'deadline', 'submit', 'exam', 'payment',
  'urgent', 'meeting', 'tomorrow', 'tonight', 'overdue', 'asap',
  'immediately', 'emergency',
];

const SOFT_KEYWORDS = [
  'today', 'soon', 'later', 'remind', 'check', 'update', 'please', 'confirm',
];

const BY_TIME_PATTERN = /\bby\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/i;
const BEFORE_DATE_PATTERN = /\bbefore\s+\w+/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function wordCount(text) {
  return text.trim().split(/\s+/).length;
}

function hasCoreKeyword(body) {
  const lower = body.toLowerCase();
  return (
    CORE_URGENT_KEYWORDS.some((kw) => lower.includes(kw)) ||
    BY_TIME_PATTERN.test(body) ||
    BEFORE_DATE_PATTERN.test(body)
  );
}

function hasSoftKeyword(body) {
  const lower = body.toLowerCase();
  return SOFT_KEYWORDS.some((kw) => lower.includes(kw));
}

function mentionsUser(message) {
  const lower = message.body.toLowerCase();
  const nameMention = config.USER_NAME && lower.includes(config.USER_NAME.toLowerCase());
  const phoneMention =
    config.USER_PHONE &&
    (lower.includes(config.USER_PHONE) ||
      (message.mentionedIds || []).some((id) => id.includes(config.USER_PHONE.replace(/\D/g, ''))));
  return nameMention || phoneMention;
}

async function callGroqForUrgency(message) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 60,
      messages: [
        {
          role: 'system',
          content: `You are an urgency classifier. Reply ONLY with valid JSON: {"isUrgent": boolean, "reason": string}.
No markdown, no backticks, no explanation.`,
        },
        {
          role: 'user',
          content: `Is this WhatsApp message urgent for someone named ${config.USER_NAME}?
Message: "${message.body}"
Urgent means: requires action today or mentions a deadline/assignment/payment/exam.`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content || '{}';
    try {
      return JSON.parse(raw);
    } catch {
      console.error(`[${ts()}] [analyzer] Failed to parse urgency JSON: ${raw}`);
      return { isUrgent: false, reason: 'json parse failed' };
    }
  } catch (err) {
    console.error(`[${ts()}] [analyzer] Groq urgency call failed: ${err.message}`);
    return { isUrgent: false, reason: 'classification failed' };
  }
}

async function classifyUrgency(message) {
  const body = message.body || '';
  const wc = wordCount(body);
  const core = hasCoreKeyword(body);
  const soft = hasSoftKeyword(body);
  const userMentioned = mentionsUser(message);
  const isReply = message.hasQuotedMsg === true;

  // Determine if inconclusive (needs Groq)
  let needsGroq = false;

  if (soft && !core) {
    needsGroq = true; // soft only → inconclusive
  } else if (userMentioned && !core) {
    needsGroq = true; // mention but no core keyword
  } else if (core && wc > 20) {
    needsGroq = true; // core keyword but message is long
  } else if (isReply && core) {
    needsGroq = true; // reply to a message with core keyword
  }

  let isUrgent = false;

  if (!needsGroq && core && wc <= 20) {
    // Clear match: core keyword, short message, no soft-only pattern
    isUrgent = true;
  } else if (needsGroq) {
    const result = await callGroqForUrgency(message);
    isUrgent = result.isUrgent === true;
  }

  if (isUrgent) {
    const telegram = require('./telegram');
    telegram.sendUrgentAlert(message);
    notifier.notifyUrgent(message);
    database.markUrgent(message.id);
  }
}

function formatMessagesForGroq(messages) {
  return messages
    .map((m) => {
      const time = new Date(m.timestamp).toTimeString().slice(0, 5);
      return `[${time}] ${m.senderName}: ${m.body}`;
    })
    .join('\n');
}

async function buildDigest(bufferedMessages) {
  const digestPayload = [];
  let firstGroqCall = true;

  for (const [chatName, entry] of bufferedMessages) {
    const { type, messages } = entry;

    if (type === 'dm') {
      digestPayload.push({
        chatName,
        type: 'dm',
        messageCount: messages.length,
      });
      continue; // No Groq for DMs
    }

    // Groups and Channels — call Groq sequentially with delay
    if (!firstGroqCall) {
      await sleep(1000);
    }
    firstGroqCall = false;

    const formattedMessages = formatMessagesForGroq(messages);
    let result;

    try {
      const response = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: `You are an AI assistant for ${config.USER_NAME}, a Computer Science student
at UG Legon, Ghana and Kusaal NLP researcher. Analyze these WhatsApp messages and return
ONLY valid JSON with no markdown, no backticks, no explanation. Schema:
{
  "summary": "string (2-3 sentences max)",
  "urgentItems": [{ "text": "string", "sender": "string", "deadline": "string" }],
  "tasks": [{ "text": "string", "deadline": "string" }],
  "news": [{ "text": "string", "category": "string" }]
}`,
          },
          {
            role: 'user',
            content: `Chat: ${chatName}\nMessages:\n${formattedMessages}`,
          },
        ],
      });

      const raw = response.choices[0]?.message?.content || '{}';
      try {
        result = JSON.parse(raw);
      } catch {
        console.error(`[${ts()}] [analyzer] buildDigest JSON parse failed for ${chatName}: ${raw.slice(0, 100)}`);
        result = null;
      }
    } catch (err) {
      console.error(`[${ts()}] [analyzer] Groq buildDigest call failed for ${chatName}: ${err.message}`);
      result = null;
    }

    if (!result) {
      result = {
        summary: 'Summary unavailable — Groq error.',
        urgentItems: [],
        tasks: [],
        news: [],
      };
    }

    const chatResult = {
      chatName,
      type,
      summary: result.summary || '',
      urgentItems: result.urgentItems || [],
      tasks: result.tasks || [],
      news: result.news || [],
      messageCount: messages.length,
    };

    digestPayload.push(chatResult);
  }

  // Persist to DB
  const allTasks = [];
  const allNews = [];

  for (const entry of digestPayload) {
    if (entry.type === 'dm') continue;

    database.saveSummary(entry.chatName, entry);

    for (const task of entry.tasks || []) {
      allTasks.push({ ...task, sourceGroup: entry.chatName });
    }
    for (const item of entry.news || []) {
      allNews.push({ ...item, sourceGroup: entry.chatName });
    }
  }

  if (allTasks.length > 0) {
    database.saveTasks(allTasks);
    const telegram = require('./telegram');
    for (const task of allTasks) {
      telegram.sendTaskUpdate({ ...task, sourceGroup: task.sourceGroup });
      notifier.notifyTask(task);
    }
  }

  if (allNews.length > 0) {
    database.saveNews(allNews);
  }

  return digestPayload;
}

async function askQuestion(question) {
  const rawMessages = database.getRecentMessages(200);
  // Filter out DMs — only group/channel messages used as context
  const groupMessages = rawMessages.filter((m) => m.is_group === 1 || m.is_channel === 1);

  const formattedMessages = groupMessages
    .map((m) => {
      const time = new Date(m.timestamp).toTimeString().slice(0, 5);
      return `[${time}] ${m.sender_name} in ${m.chat_name}: ${m.body}`;
    })
    .join('\n');

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant for ${config.USER_NAME}. Answer questions
about recent WhatsApp group activity based on the messages provided. Be concise and direct.`,
        },
        {
          role: 'user',
          content: `Recent group messages:\n${formattedMessages}\n\nQuestion: ${question}`,
        },
      ],
    });
    return response.choices[0]?.message?.content || 'No answer available.';
  } catch (err) {
    console.error(`[${ts()}] [analyzer] askQuestion Groq call failed: ${err.message}`);
    return `Error: Could not get an answer — ${err.message}`;
  }
}

module.exports = { classifyUrgency, buildDigest, askQuestion };
