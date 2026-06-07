// Desktop notifications only work in local/GUI environments
const isCloud = process.env.NODE_ENV === 'production' || !process.env.DISPLAY && process.platform !== 'win32' && process.platform !== 'darwin';

let notifier = null;
if (!isCloud) {
  try { notifier = require('node-notifier'); } catch {}
}

function notifyUrgent(message) {
  if (!notifier) return;
  try {
    notifier.notify({
      title: `🚨 Urgent — ${message.chatName}`,
      message: `${message.senderName}: ${message.body.substring(0, 80)}`,
      sound: true,
      wait: false,
    });
  } catch {}
}

function notifyTask(task) {
  if (!notifier) return;
  try {
    notifier.notify({
      title: '📋 New Task',
      message: `${task.text.substring(0, 80)} — Due: ${task.deadline || 'Not specified'}`,
      sound: false,
      wait: false,
    });
  } catch {}
}

function notifyDigest(digestPayload) {
  if (!notifier) return;
  try {
    const groupCount = digestPayload.filter((d) => d.type !== 'dm').length;
    const dmCount = digestPayload.filter((d) => d.type === 'dm').length;
    notifier.notify({
      title: '🤖 WA Digest',
      message: `${groupCount} group(s) · ${dmCount} DM(s) · ${new Date().toLocaleTimeString()}`,
      sound: false,
      wait: false,
    });
  } catch {}
}

module.exports = { notifyUrgent, notifyTask, notifyDigest };
