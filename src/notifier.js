const notifier = require('node-notifier');

function notifyUrgent(message) {
  try {
    notifier.notify({
      title: `🚨 Urgent — ${message.chatName}`,
      message: `${message.senderName}: ${message.body.substring(0, 80)}`,
      sound: true,
      wait: false,
    });
  } catch (err) {
    console.error(`[notifier] notifyUrgent failed: ${err.message}`);
  }
}

function notifyTask(task) {
  try {
    notifier.notify({
      title: '📋 New Task',
      message: `${task.text.substring(0, 80)} — Due: ${task.deadline || 'Not specified'}`,
      sound: false,
      wait: false,
    });
  } catch (err) {
    console.error(`[notifier] notifyTask failed: ${err.message}`);
  }
}

function notifyDigest(digestPayload) {
  try {
    const groupCount = digestPayload.filter((d) => d.type !== 'dm').length;
    const dmCount = digestPayload.filter((d) => d.type === 'dm').length;
    notifier.notify({
      title: '🤖 WA Digest',
      message: `${groupCount} group(s) · ${dmCount} DM(s) · ${new Date().toLocaleTimeString()}`,
      sound: false,
      wait: false,
    });
  } catch (err) {
    console.error(`[notifier] notifyDigest failed: ${err.message}`);
  }
}

module.exports = { notifyUrgent, notifyTask, notifyDigest };
