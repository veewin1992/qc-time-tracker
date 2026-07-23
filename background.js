// Background Service Worker — Retail AdCopy
// Fires a Chrome notification when a running timer passes REMINDER_MINUTES,
// then again at each further interval, WITHOUT ever pausing the timer.
// Works whether the popup is open or closed (driven by chrome.alarms).

const APP_NAME = 'Retail AdCopy';
const REMINDER_MINUTES = 5;          // <-- reminder interval for this extension
const POLL_ALARM = 'radcopy-reminder-poll';
const NOTIF_ID = 'radcopy-timer-reminder';

// Keep a 1-minute heartbeat alarm alive so the worker can check the timer
// even when the popup is closed.
function ensurePollAlarm() {
  chrome.alarms.get(POLL_ALARM, (a) => {
    if (!a) chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
  });
}
ensurePollAlarm();
chrome.runtime.onInstalled.addListener(ensurePollAlarm);
chrome.runtime.onStartup.addListener(ensurePollAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) runReminderCheck();
});

async function runReminderCheck() {
  try {
    const store = await chrome.storage.local.get(
      ['sessions', 'activeSessionId', 'settings', 'reminderState']
    );
    const sessions = Array.isArray(store.sessions) ? store.sessions : [];
    const settings = store.settings || {};
    // Respect the user's notification preference (Settings toggle)
    if (settings.notificationsEnabled === false) return;

    // Prefer the active session; otherwise any running one.
    const active = sessions.find(s => s.id === store.activeSessionId);
    let running = (active && active.isRunning && !active.isPaused) ? active : null;
    if (!running) running = sessions.find(s => s.isRunning && !s.isPaused);

    const prev = store.reminderState || {};

    if (!running) {
      if (prev.sessionId) await chrome.storage.local.set({ reminderState: {} });
      return;
    }

    const now = Date.now();
    const elapsedMs = (running.accumulated || 0) +
                      (running.startTime ? (now - running.startTime) : 0);
    const thresholdMs = REMINDER_MINUTES * 60 * 1000;
    const multiple = Math.floor(elapsedMs / thresholdMs); // 0 until first threshold

    const lastMultiple = (prev.sessionId === running.id) ? (prev.lastMultiple || 0) : 0;

    if (multiple >= 1 && multiple > lastMultiple) {
      showReminder(running, REMINDER_MINUTES * multiple);
      await chrome.storage.local.set({
        reminderState: { sessionId: running.id, lastMultiple: multiple }
      });
    } else if (prev.sessionId !== running.id) {
      await chrome.storage.local.set({
        reminderState: { sessionId: running.id, lastMultiple: 0 }
      });
    }
  } catch (e) {
    console.warn('reminder check failed:', e);
  }
}

function showReminder(session, mins) {
  const ticket = (session.ticketNo || '').trim();
  const label = ticket ? `"${ticket}"` : 'Your timer';
  chrome.notifications.create(NOTIF_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `\u23F1 ${APP_NAME} \u2014 still running`,
    message: `${label} has been running for ${mins} minutes. Still working? The timer is still counting in the background.`,
    contextMessage: 'Tap "Open tracker" to review, or "Keep running" to continue.',
    buttons: [{ title: 'Keep running' }, { title: 'Open tracker' }],
    priority: 2,
    requireInteraction: true
  });
}

function openTracker() {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') });
}

chrome.notifications.onButtonClicked.addListener((id, idx) => {
  if (id !== NOTIF_ID) return;
  if (idx === 1) openTracker();     // "Open tracker"
  chrome.notifications.clear(NOTIF_ID);
});

chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIF_ID) return;
  openTracker();
  chrome.notifications.clear(NOTIF_ID);
});

// Legacy message hook (kept for compatibility)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'ping') sendResponse({ status: 'ok' });
  return false;
});
