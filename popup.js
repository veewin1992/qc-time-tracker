// QC Time Tracker — Enhanced Version 3.0
// Multi-tab support for tracking multiple tickets simultaneously

const TICKET_TYPES = [
  "Ad Copy","Ad Copy VIP","Ampersand","Ampersand Broken Rule",
  "Ampersand Digital","Ampersand Digital AA","Ampersand Digital AA Political","Ampersand Digital Political","Ampersand Dish",
  "Ampersand Political","Ampersand Political Dish","Ampersand Tune In","Ampersand VIP",
  "Audience Addressable Retail","Digital & Linear Ad Copy","Digital Ad Copy","Political - Linear"
];

// Detect if running inside the small popup or a full browser tab.
// The tab we open is flagged with ?tab=1 so it's detected reliably
// regardless of window width (prevents re-open loops in narrow windows).
function isRunningInTab() {
  try {
    if (new URLSearchParams(location.search).get('tab') === '1') return true;
  } catch (e) { /* ignore */ }
  return window.innerWidth > 500;
}

function openInTab(hash = '#settings') {
  const base = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL('popup.html')
    : 'popup.html';
  const url = base + '?tab=1' + hash;
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, '_blank');
  }
}

// ── Multi-Session State ──
let currentUser     = null;
let sessions        = [];          // Array of session objects
let activeSessionId = null;        // Currently active session ID
let selectedType    = "";
let tState          = "idle";
let accumulated     = 0;
let elapsed         = 0;
let displayInterval = null;
let allEntries      = [];
let recentTickets   = [];
let settings        = { soundEnabled: true, notificationsEnabled: true, theme: 'dark' };

const TEAM_SYNC_DB_NAME = 'qc-time-tracker-folder-sync';
const TEAM_SYNC_DB_VERSION = 1;
const TEAM_SYNC_HANDLE_STORE = 'handles';
const TEAM_SYNC_FOLDER_KEY = 'shared-team-folder';
const TEAM_FILE_PREFIX = 'qc-time-tracker-team-';
const TEAM_FILE_EXTENSION = '.json';
// Cache the folder handle in memory so re-grant can call requestPermission()
// directly inside the click gesture — an IndexedDB await first can drop the
// browser's "user activation" and make the permission prompt silently fail.
let cachedFolderHandle = null;

// Session structure:
// {
//   id: unique_id,
//   ticketNo: string,
//   clientName: string,
//   ticketType: string,
//   numOrders: string,
//   comment: string,
//   startTime: timestamp,
//   pauseTimes: [timestamps],
//   resumeTimes: [timestamps],
//   stopTime: null | timestamp,
//   accumulated: ms,
//   isRunning: bool,
//   isPaused: bool
// }

function createSession() {
  return {
    id: Date.now().toString(),
    ticketNo: '',
    clientName: '',
    ticketType: '',
    numOrders: '',
    orderNumber: '',
    comment: '',
    startTime: null,
    firstStartTime: null,     // true session start — set once, never overwritten by pause/resume/reopen
    lastSyncTime: Date.now(),  // Track when session was last synced
    pauseTimes: [],
    resumeTimes: [],
    stopTime: null,
    accumulated: 0,
    isRunning: false,
    isPaused: false
  };
}

function getActiveSession() {
  return sessions.find(s => s.id === activeSessionId) || null;
}

function getSessionDuration(session) {
  let total = session.accumulated || 0;
  if (session.isRunning && !session.isPaused && session.startTime) {
    total += Date.now() - session.startTime;
  }
  return total;
}

function hasSessionData(session) {
  // Check if session has any meaningful data
  return !!(session.ticketNo || session.clientName || session.ticketType || 
           session.numOrders || session.orderNumber || session.comment || session.accumulated || 
           session.startTime || session.pauseTimes.length > 0);
}

// Check if running in extension context
function isExtensionContext() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

function storageGet(keys) {
  return new Promise((resolve) => {
    if (isExtensionContext()) {
      try {
        chrome.storage.local.get(keys, (result) => {
          resolve(result || {});
        });
      } catch (e) {
        resolve({});
      }
    } else {
      // Fallback to localStorage for testing outside extension
      const result = {};
      keys.forEach(key => {
        try {
          const val = localStorage.getItem(key);
          result[key] = val ? JSON.parse(val) : null;
        } catch { result[key] = null; }
      });
      resolve(result);
    }
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    if (isExtensionContext()) {
      try {
        chrome.storage.local.set(items, () => {
          resolve();
        });
      } catch (e) {
        resolve();
      }
    } else {
      // Fallback to localStorage
      Object.entries(items).forEach(([key, val]) => {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
      });
      resolve();
    }
  });
}

function isFolderSyncSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// Escapes text inserted into modal HTML (edit dialog field values) so a ticket
// number, client name, or comment containing quotes/angle-brackets can't break
// the markup or inject HTML.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function sanitizeFileSegment(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'member';
}

function buildEntryKey(entry) {
  return entry && entry.id
    ? String(entry.id)
    : [
        entry?.userEmail || '',
        entry?.date || '',
        entry?.ticketNo || '',
        entry?.startTime || '',
        entry?.stopTime || ''
      ].join('|');
}

function getEntrySortTime(entry) {
  const timePart = entry && entry.stopTime ? entry.stopTime : '00:00:00';
  const stamp = Date.parse(`${entry?.date || '1970-01-01'}T${timePart}`);
  return Number.isNaN(stamp) ? 0 : stamp;
}

function dedupeEntries(entries) {
  const map = new Map();
  (entries || []).forEach(entry => {
    if (!entry) return;
    map.set(buildEntryKey(entry), entry);
  });
  return Array.from(map.values()).sort((a, b) => getEntrySortTime(b) - getEntrySortTime(a));
}

function getMemberSyncFileName(user = currentUser) {
  const identity = user?.email || user?.name || 'member';
  return `${TEAM_FILE_PREFIX}${sanitizeFileSegment(identity)}${TEAM_FILE_EXTENSION}`;
}

function emptyTeamFilePayload(user = currentUser) {
  return {
    version: 1,
    user: user ? { name: user.name || '', email: user.email || '' } : { name: '', email: '' },
    updatedAt: new Date().toISOString(),
    entries: []
  };
}

function parseTeamFilePayload(rawText) {
  if (!rawText) return emptyTeamFilePayload();
  try {
    const parsed = JSON.parse(rawText);
    return {
      version: parsed.version || 1,
      user: parsed.user || { name: '', email: '' },
      updatedAt: parsed.updatedAt || '',
      entries: Array.isArray(parsed.entries) ? parsed.entries : []
    };
  } catch {
    return emptyTeamFilePayload();
  }
}

function openTeamSyncDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available.'));
      return;
    }

    const request = indexedDB.open(TEAM_SYNC_DB_NAME, TEAM_SYNC_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TEAM_SYNC_HANDLE_STORE)) {
        db.createObjectStore(TEAM_SYNC_HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open team sync database.'));
  });
}

async function idbHandleGet(key) {
  const db = await openTeamSyncDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEAM_SYNC_HANDLE_STORE, 'readonly');
    const store = tx.objectStore(TEAM_SYNC_HANDLE_STORE);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read saved folder handle.'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
    tx.onabort = () => db.close();
  });
}

async function idbHandleSet(key, value) {
  const db = await openTeamSyncDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEAM_SYNC_HANDLE_STORE, 'readwrite');
    const store = tx.objectStore(TEAM_SYNC_HANDLE_STORE);
    const request = store.put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Could not save folder handle.'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
    tx.onabort = () => db.close();
  });
}

async function idbHandleDelete(key) {
  const db = await openTeamSyncDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TEAM_SYNC_HANDLE_STORE, 'readwrite');
    const store = tx.objectStore(TEAM_SYNC_HANDLE_STORE);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('Could not clear folder handle.'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
    tx.onabort = () => db.close();
  });
}

async function queryHandlePermission(handle, readWrite = false) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'granted';
  try {
    const perm = await handle.queryPermission(readWrite ? { mode: 'readwrite' } : {});
    return perm || 'prompt';  // Ensure we always return a valid state
  } catch (e) {
    console.warn('queryPermission error:', e);
    return 'prompt';
  }
}

async function ensureHandlePermission(handle, readWrite = false) {
  if (!handle) return false;
  const options = readWrite ? { mode: 'readwrite' } : {};

  try {
    if (typeof handle.queryPermission === 'function') {
      try {
        const existing = await handle.queryPermission(options);
        if (existing === 'granted') return true;
      } catch (e) {
        console.warn('queryPermission failed:', e);
      }
    }

    if (typeof handle.requestPermission === 'function') {
      try {
        const requested = await handle.requestPermission(options);
        return requested === 'granted';
      } catch (e) {
        console.warn('requestPermission failed:', e);
        return false;
      }
    }

    // Browser has no permission API — assume access is available
    return true;
  } catch (e) {
    console.error('ensureHandlePermission unexpected error:', e);
    return false;
  }
}

async function getStoredTeamFolderHandle() {
  if (!isFolderSyncSupported()) return null;
  try {
    const handle = await idbHandleGet(TEAM_SYNC_FOLDER_KEY);
    if (handle) cachedFolderHandle = handle;
    return handle;
  } catch {
    return null;
  }
}

async function setStoredTeamFolderHandle(handle) {
  if (!isFolderSyncSupported()) return;
  await idbHandleSet(TEAM_SYNC_FOLDER_KEY, handle);
  cachedFolderHandle = handle;
}

async function removeStoredTeamFolderHandle() {
  if (!isFolderSyncSupported()) return;
  await idbHandleDelete(TEAM_SYNC_FOLDER_KEY);
  cachedFolderHandle = null;
}

async function resolveTeamFolderHandle(options = {}) {
  const { readWrite = false, requestIfNeeded = false } = options;
  const handle = await getStoredTeamFolderHandle();
  if (!handle) return null;

  const allowed = requestIfNeeded
    ? await ensureHandlePermission(handle, readWrite)
    : (await queryHandlePermission(handle, readWrite)) === 'granted';

  return allowed ? handle : null;
}

async function getSyncSettings() {
  const result = await storageGet(['syncSettings']);
  return result.syncSettings || {};
}

async function saveSyncSettings(patch) {
  const current = await getSyncSettings();
  const next = { ...current, ...patch };
  await storageSet({ syncSettings: next });
  return next;
}

async function getLocalEntries() {
  const result = await storageGet(['entries']);
  return Array.isArray(result.entries) ? result.entries : [];
}

async function getCurrentUserLocalEntries() {
  const localEntries = await getLocalEntries();
  if (!currentUser || !currentUser.email) return [];

  return localEntries.filter(entry =>
    (entry.userEmail || '').toLowerCase() === currentUser.email.toLowerCase()
  );
}

async function readTeamPayloadFromFile(fileHandle) {
  try {
    const file = await fileHandle.getFile();
    return parseTeamFilePayload(await file.text());
  } catch {
    return emptyTeamFilePayload();
  }
}

async function writeCurrentUserEntriesToTeamFolder(entries, options = {}) {
  const { requestIfNeeded = false, allowEmpty = false } = options;

  if (!currentUser) {
    return { ok: false, reason: 'login-required' };
  }

  const storedHandle = await getStoredTeamFolderHandle();
  const folderHandle = await resolveTeamFolderHandle({ readWrite: true, requestIfNeeded });
  if (!folderHandle) {
    // Distinguish: folder was set up but permission was denied vs folder was never configured
    return { ok: false, reason: storedHandle ? 'permission-denied' : 'folder-not-ready' };
  }

  const userEntries = dedupeEntries((entries || []).filter(entry =>
    (entry.userEmail || '').toLowerCase() === currentUser.email.toLowerCase()
  ));

  if (!userEntries.length && !allowEmpty) {
    return { ok: false, reason: 'no-local-entries' };
  }

  try {
    const fileName = getMemberSyncFileName(currentUser);
    const fileHandle = await folderHandle.getFileHandle(fileName, { create: true });
    const existingPayload = await readTeamPayloadFromFile(fileHandle);
    // File entries are applied LAST so they win on id collision. This matters
    // once Dashboard edits/deletes can rewrite another person's file directly:
    // without this order, a stale local copy re-pushed by this same routine
    // would silently overwrite someone else's edit the next time this user submits.
    const mergedEntries = userEntries.length
      ? dedupeEntries([...userEntries, ...(existingPayload.entries || [])])
      : dedupeEntries(existingPayload.entries || []);
    const updatedAt = new Date().toISOString();

    const payload = {
      version: 1,
      user: {
        name: currentUser.name || '',
        email: currentUser.email || ''
      },
      updatedAt,
      entries: mergedEntries
    };

    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();

    await saveSyncSettings({
      mode: 'shared-onedrive-folder',
      sharedFolderName: folderHandle.name,
      memberFileName: fileName,
      lastWriteAt: updatedAt
    });

    return {
      ok: true,
      folderName: folderHandle.name,
      fileName,
      entryCount: mergedEntries.length
    };
  } catch (error) {
    console.warn('Could not write team folder data:', error.message);
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { ok: false, reason: 'permission-denied', error };
    }
    return { ok: false, reason: 'write-failed', error };
  }
}

async function syncCurrentUserEntriesToTeamFolder(options = {}) {
  const userEntries = await getCurrentUserLocalEntries();
  return writeCurrentUserEntriesToTeamFolder(userEntries, options);
}

// Overwrites a specific member's team file with an exact entry list. Unlike
// writeCurrentUserEntriesToTeamFolder (which only ever adds/keeps entries),
// this replaces the file's contents wholesale — needed so Dashboard Edit can
// change a field and Delete can remove an entry entirely. Folder access is
// granted at the directory level, so this can target any member's file, not
// just the signed-in user's own.
async function writeExactEntriesForOwner(ownerEmail, ownerName, fullEntries, options = {}) {
  const { requestIfNeeded = true } = options;

  const storedHandle = await getStoredTeamFolderHandle();
  const folderHandle = await resolveTeamFolderHandle({ readWrite: true, requestIfNeeded });
  if (!folderHandle) {
    return { ok: false, reason: storedHandle ? 'permission-denied' : 'folder-not-ready' };
  }

  try {
    const fileName = getMemberSyncFileName({ email: ownerEmail, name: ownerName });
    const fileHandle = await folderHandle.getFileHandle(fileName, { create: true });
    const updatedAt = new Date().toISOString();

    const payload = {
      version: 1,
      user: { name: ownerName || '', email: ownerEmail || '' },
      updatedAt,
      entries: dedupeEntries(fullEntries || [])
    };

    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();

    return { ok: true, folderName: folderHandle.name, fileName, entryCount: payload.entries.length };
  } catch (error) {
    console.warn('Could not write owner entry list:', error.message);
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { ok: false, reason: 'permission-denied', error };
    }
    return { ok: false, reason: 'write-failed', error };
  }
}

async function loadTeamEntriesFromFolder(options = {}) {
  const { requestIfNeeded = false } = options;
  const folderHandle = await resolveTeamFolderHandle({ readWrite: false, requestIfNeeded });
  if (!folderHandle) {
    return { ok: false, reason: 'folder-not-ready', entries: [] };
  }

  try {
    const collectedEntries = [];
    let fileCount = 0;

    for await (const entryHandle of folderHandle.values()) {
      if (!entryHandle || entryHandle.kind !== 'file') continue;
      if (!entryHandle.name.startsWith(TEAM_FILE_PREFIX) || !entryHandle.name.endsWith(TEAM_FILE_EXTENSION)) continue;

      fileCount += 1;
      const file = await entryHandle.getFile();
      const payload = parseTeamFilePayload(await file.text());
      if (Array.isArray(payload.entries) && payload.entries.length) {
        collectedEntries.push(...payload.entries);
      }
    }

    const dedupedEntries = dedupeEntries(collectedEntries);
    await saveSyncSettings({
      mode: 'shared-onedrive-folder',
      sharedFolderName: folderHandle.name,
      lastReadAt: new Date().toISOString()
    });

    return {
      ok: true,
      folderName: folderHandle.name,
      fileCount,
      entries: dedupedEntries
    };
  } catch (error) {
    console.warn('Could not read team folder data:', error.message);
    return { ok: false, reason: 'read-failed', entries: [], error };
  }
}

// ── Folder access diagnosis (write-probe) ──
// Distinguishes the real-world causes of "not granted":
//   not-signed-in / unsupported / no-folder / need-permission / write-blocked / ok
async function safeRemoveFile(dirHandle, name) {
  try {
    if (dirHandle && typeof dirHandle.removeEntry === 'function') {
      await dirHandle.removeEntry(name);
    }
  } catch (e) {
    // Cleanup failures are non-fatal; OneDrive may also remove the temp file.
    console.warn('Could not remove probe file:', e?.message);
  }
}

async function diagnoseSharedFolder() {
  if (!currentUser || !currentUser.email) return { code: 'not-signed-in' };
  if (!isFolderSyncSupported())            return { code: 'unsupported' };

  const handle = await getStoredTeamFolderHandle();
  if (!handle) return { code: 'no-folder' };

  // Must run from a user gesture (this is called from button handlers).
  const granted = await ensureHandlePermission(handle, true);
  if (!granted) return { code: 'need-permission', folderName: handle.name };

  // Prove the folder is genuinely writable AND synced to disk by
  // creating, writing, reading back, and deleting a tiny temp file.
  const probeName = `qc-access-check-${Date.now()}.tmp`;
  try {
    const fh = await handle.getFileHandle(probeName, { create: true });
    const writable = await fh.createWritable();
    await writable.write('qc-ok');
    await writable.close();
    const file = await fh.getFile();
    await file.text();                       // forces OneDrive to hydrate the file
    await safeRemoveFile(handle, probeName);
    return { code: 'ok', folderName: handle.name };
  } catch (e) {
    await safeRemoveFile(handle, probeName);
    return {
      code: 'write-blocked',
      folderName: handle.name,
      errName: e?.name || '',
      detail: e?.message || ''
    };
  }
}

function setAdminStatus(text, tone = 'muted') {
  const el = document.getElementById('admin-status');
  if (!el) return;

  const palette = {
    success: '#34d399',
    warn: '#f59e0b',
    error: '#ef4444',
    muted: '#6b7280'
  };

  el.textContent = text;
  el.style.color = palette[tone] || palette.muted;
}

function setFolderStatus(html) {
  const el = document.getElementById('folder-status');
  if (el) el.innerHTML = html;
}

function updateTeamFileHint(fileName) {
  const hint = document.getElementById('team-file-hint');
  if (!hint) return;

  if (fileName) {
    hint.textContent = `Your file in the shared folder: ${fileName}`;
    return;
  }

  hint.textContent = currentUser
    ? `When connected, your file will be: ${getMemberSyncFileName(currentUser)}`
    : 'Sign in first, then choose the shared OneDrive folder.';
}

function renderSyncMeta(syncSettings = {}) {
  const meta = document.getElementById('folder-meta');
  if (!meta) return;

  const fragments = [];
  if (syncSettings.sharedFolderName) fragments.push(`Folder: ${syncSettings.sharedFolderName}`);
  if (syncSettings.memberFileName) fragments.push(`File: ${syncSettings.memberFileName}`);
  if (syncSettings.lastWriteAt) fragments.push(`Last write: ${new Date(syncSettings.lastWriteAt).toLocaleString()}`);
  if (syncSettings.lastReadAt) fragments.push(`Last read: ${new Date(syncSettings.lastReadAt).toLocaleString()}`);

  meta.textContent = fragments.length
    ? fragments.join(' | ')
    : 'Use the same shared OneDrive folder on every device.';
}

function buildSubmitFlashMessage(syncResult) {
  if (syncResult.ok) {
    return '✓ Entry saved locally and shared to the team folder.';
  }

  if (syncResult.reason === 'permission-denied') {
    return '✓ Entry saved locally. Folder access needs to be re-granted — open Settings and click "Re-grant Folder Access".';
  }

  if (syncResult.reason === 'folder-not-ready') {
    return '✓ Entry saved locally. Open Settings and connect the shared OneDrive folder to share team data.';
  }

  if (syncResult.reason === 'write-failed') {
    return '✓ Entry saved locally. The shared folder could not be updated — open Settings to reconnect.';
  }

  return '✓ Entry saved locally.';
}

// ══════════════ UTILS ══════════════

function fmt(ms) {
  const s  = Math.floor(ms / 1000);
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(sc)}`;
}
function pad(n) { return String(n).padStart(2, "0"); }

function formatTimeHHMMSS(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById("screen-" + id).classList.add("active");
  // The dashboard table needs real width in a full tab; other screens keep the
  // focused column layout.
  document.body.classList.toggle('wide-mode', id === 'admin');
}

function flash(elId, text, ok) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className   = "alert " + (ok ? "alert-ok" : "alert-err");
  el.style.display = "block";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = "none"; }, 3200);
}

// ══════════════ SOUND EFFECTS ══════════════

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playBeep(frequency = 800, duration = 200, type = 'sine') {
  if (!settings.soundEnabled) return;
  try {
    const ctx = getAudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.frequency.value = frequency;
    oscillator.type = type;
    gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration / 1000);
    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration / 1000);
  } catch (e) {}
}

function playSound(type) {
  if (!settings.soundEnabled) return;
  // Audio context requires user interaction first
  // This is a browser security feature
  try {
    switch(type) {
      case 'start': playBeep(600, 300); setTimeout(() => playBeep(800, 200), 150); break;
      case 'stop': playBeep(800, 200); setTimeout(() => playBeep(600, 300), 150); break;
      case 'pause': playBeep(500, 250); break;
      case 'resume': playBeep(700, 250); break;
      case 'submit': playBeep(1000, 150); setTimeout(() => playBeep(1200, 150), 100); break;
      case 'error': playBeep(300, 400, 'sawtooth'); break;
    }
  } catch (e) {
    // Audio might be blocked - ignore errors
  }
}

// ══════════════ THEME ══════════════

function applyTheme() {
  const theme = settings.theme === 'light' ? 'light' : 'dark';
  document.body.setAttribute('data-theme', theme);
  // Keep the page backdrop matching so rounded corners don't reveal a mismatch.
  document.documentElement.style.background = theme === 'light' ? '#eef1f0' : '#07071a';
  document.querySelectorAll('.theme-swatch').forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.themeChoice === theme);
  });
}

// ══════════════ LOGIN ══════════════

async function doLogin() {
  const name  = document.getElementById("ln-name").value.trim();
  const email = document.getElementById("ln-email").value.trim();
  const err   = document.getElementById("ln-err");
  
  if (!name || !email) {
    err.textContent = "Name and email are required.";
    err.style.display = "block";
    return;
  }
  if (!/\S+@\S+\.\S+/.test(email)) {
    err.textContent = "Enter a valid email address.";
    err.style.display = "block";
    return;
  }
  err.style.display = "none";
  currentUser = { name, email };
  try {
    await storageSet({ "qc-user": currentUser });
    document.getElementById("tr-user").textContent = "👤 " + name;
    showScreen("tracker");
    playSound('submit');
  } catch (e) {
    err.textContent = "Error saving login. Please try again.";
    err.style.display = "block";
  }
}

async function doLogout() {
  currentUser = null;
  stopBackgroundSync();  // Stop background sync on logout
  await storageSet({ "qc-user": null });
  document.getElementById("ln-name").value  = "";
  document.getElementById("ln-email").value = "";
  resetFormFields();  // Reset form fields
  showScreen("login");
}

// ══════════════ DROPDOWN ══════════════

function renderDrop(filter) {
  const list  = document.getElementById("tt-list");
  const items = TICKET_TYPES.filter(t =>
    t.toLowerCase().includes((filter || "").toLowerCase())
  );
  if (!items.length) {
    list.innerHTML = `<div class="dd-item" style="color:#4b5568;cursor:default">No matches found</div>`;
    return;
  }
  list.innerHTML = items.map(t => `
    <div class="dd-item ${selectedType === t ? "sel" : ""}" data-type="${t.replace(/"/g, '&quot;')}">
      ${t}
      ${selectedType === t ? '<span style="font-size:11px">✓</span>' : ""}
    </div>`).join("");
}

// Handle dropdown item clicks via event delegation
function setupDropdownDelegation() {
  const list = document.getElementById("tt-list");
  if (list) {
    list.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.dd-item');
      if (item && item.dataset.type) {
        pickType(item.dataset.type);
      }
    });
  }
}

function openDrop() {
  document.getElementById("tt-list").classList.add("open");
  document.getElementById("tt-chevron").textContent = "▲";
  renderDrop(document.getElementById("tt-search").value);
}

function closeDrop() {
  document.getElementById("tt-list").classList.remove("open");
  document.getElementById("tt-chevron").textContent = "▼";
}

function pickType(t) {
  selectedType = t;
  document.getElementById("tt-search").value = "";
  document.getElementById("tt-badge").innerHTML =
    `<span class="sel-badge">${t} ✓</span>`;
  closeDrop();
  
  // Save to active session
  const session = getActiveSession();
  if (session) {
    session.ticketType = t;
    saveSessions();
  }
  
  playSound('submit');
}

// ══════════════ RECENT TICKETS ══════════════

async function loadRecentTickets() {
  const result = await storageGet(['recentTickets']);
  recentTickets = result.recentTickets || [];
  renderRecentTickets();
}

function renderRecentTickets() {
  const container = document.getElementById('recent-tickets');
  if (!container) return;
  
  if (recentTickets.length === 0) {
    container.innerHTML = '';
    return;
  }
  
  container.innerHTML = `
    <div class="recent-label">Recent Tickets</div>
    <div class="recent-list" id="recent-list">
      ${recentTickets.map((ticket, index) => `
        <button class="recent-item" data-index="${index}">
          <span class="rt-ticket">${ticket.ticket}</span>
          <span class="rt-client">${ticket.client}</span>
        </button>
      `).join('')}
    </div>
  `;
  
  // Attach event listeners to recent items
  const list = document.getElementById('recent-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.recent-item');
      if (item) {
        const index = parseInt(item.dataset.index);
        const ticket = recentTickets[index];
        if (ticket) {
          fillTicket(ticket.ticket, ticket.client, ticket.type);
        }
      }
    });
  }
}

function fillTicket(ticket, client, type) {
  document.getElementById("f-ticket").value = ticket;
  document.getElementById("f-client").value = client;
  
  const session = getActiveSession();
  if (session) {
    session.ticketNo = ticket;
    session.clientName = client;
  }
  
  pickType(type);
}

async function addToRecent(entry) {
  // Remove if exists
  recentTickets = recentTickets.filter(t => t.ticket !== entry.ticketNo);
  // Add to front
  recentTickets.unshift({
    ticket: entry.ticketNo,
    client: entry.clientName,
    type: entry.ticketType,
    date: entry.date
  });
  // Keep only last 5
  recentTickets = recentTickets.slice(0, 5);
  await storageSet({ recentTickets: recentTickets });
  renderRecentTickets();
}

// ══════════════ TAB MANAGEMENT ══════════════

function renderTabs() {
  const tabsList = document.getElementById('tabs-list');
  if (!tabsList) return;
  
  tabsList.innerHTML = sessions.map(s => {
    const tabLabel = s.ticketNo || '+ New';
    return `
      <div class="tab ${s.id === activeSessionId ? 'active' : ''}" data-session-id="${s.id}">
        <span class="tab-ticket">${tabLabel}</span>
        <span class="tab-state ${s.isPaused ? 'paused' : s.isRunning ? 'running' : ''}">
          ${s.isPaused ? '⏸' : s.isRunning ? '●' : '○'}
        </span>
        <button class="tab-close" data-close-id="${s.id}">✕</button>
      </div>
    `;
  }).join('');
  
  // Attach event listeners after rendering
  attachTabEventListeners();
}

function attachTabEventListeners() {
  // Tab switching
  document.querySelectorAll('.tab').forEach(tabEl => {
    tabEl.addEventListener('click', (e) => {
      // Don't switch if clicking the close button
      if (e.target.closest('.tab-close')) return;
      const sessionId = tabEl.dataset.sessionId;
      switchSession(sessionId);
    });
  });
  
  // Tab closing
  document.querySelectorAll('.tab-close').forEach(closeBtn => {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sessionId = closeBtn.dataset.closeId;
      closeTabWithCheck(sessionId);
    });
  });
}

function closeTabWithCheck(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;
  
  // Check if tab has data
  if (hasSessionData(session)) {
    // Show confirmation dialog
    showConfirmDialog(
      "Data in Tab",
      `Tab "${session.ticketNo || 'New'}" has data. Do you want to remove it?`,
      () => {
        // User clicked Yes - close the tab
        closeTab(sessionId);
      },
      () => {
        // User clicked No - stay in current tab (do nothing)
      }
    );
  } else {
    // No data - close directly
    closeTab(sessionId);
  }
}

function showConfirmDialog(title, message, onYes, onNo) {
  // Remove existing dialog if any
  const existingDialog = document.getElementById('confirm-dialog');
  if (existingDialog) existingDialog.remove();
  
  const dialogHTML = `
    <div id="confirm-dialog">
      <div class="confirm-box">
        <div class="confirm-title">${title}</div>
        <div class="confirm-message">${message}</div>
        <div class="confirm-buttons">
          <button id="confirm-no" class="confirm-btn confirm-btn-no">No, Keep It</button>
          <button id="confirm-yes" class="confirm-btn confirm-btn-yes">Yes, Remove</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', dialogHTML);
  
  const dialog = document.getElementById('confirm-dialog');
  const btnYes = document.getElementById('confirm-yes');
  const btnNo = document.getElementById('confirm-no');
  
  btnYes.addEventListener('click', () => {
    dialog.remove();
    onYes();
  });
  
  btnNo.addEventListener('click', () => {
    dialog.remove();
    onNo();
  });
  
  // Close on background click
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.remove();
      onNo();
    }
  });
}

function switchSession(sessionId) {
  if (activeSessionId === sessionId) return;
  
  // Save current form data to current session
  const current = getActiveSession();
  if (current) {
    current.ticketNo = document.getElementById("f-ticket").value.trim();
    current.clientName = document.getElementById("f-client").value.trim();
    current.ticketType = selectedType;
    current.numOrders = document.getElementById("f-orders").value.trim();
    current.orderNumber = document.getElementById("f-ordernum").value.trim();
    current.comment = document.getElementById("f-comment").value.trim();
  }
  
  // Switch to new session
  activeSessionId = sessionId;
  loadSessionToForm();
  renderTabs();
  refreshDisplay();
  playSound('submit');
  
  // Persist sessions to storage
  saveSessions();
}

function newSession() {
  // Save current session
  const current = getActiveSession();
  if (current) {
    current.ticketNo = document.getElementById("f-ticket").value.trim();
    current.clientName = document.getElementById("f-client").value.trim();
    current.ticketType = selectedType;
    current.numOrders = document.getElementById("f-orders").value.trim();
    current.orderNumber = document.getElementById("f-ordernum").value.trim();
    current.comment = document.getElementById("f-comment").value.trim();
  }
  
  // Create and activate new session
  const newSess = createSession();
  sessions.push(newSess);
  activeSessionId = newSess.id;
  
  resetFormFields();
  renderTabs();
  refreshDisplay();
  playSound('submit');
  
  // Persist sessions to storage
  saveSessions();
}

function closeTab(sessionId) {
  sessions = sessions.filter(s => s.id !== sessionId);
  
  if (activeSessionId === sessionId) {
    activeSessionId = sessions.length > 0 ? sessions[0].id : null;
    if (activeSessionId) {
      loadSessionToForm();
    } else {
      resetFormFields();
      newSession();
    }
  }
  
  renderTabs();
  refreshDisplay();
  
  // Persist sessions to storage
  saveSessions();
}

function saveSessions() {
  // Update sync time on all sessions before saving
  const now = Date.now();
  sessions.forEach(session => {
    session.lastSyncTime = now;
  });
  
  // Save sessions and active session ID to Chrome storage
  storageSet({
    sessions: sessions,
    activeSessionId: activeSessionId
  });
}

async function loadSessions() {
  // Load sessions from Chrome storage
  const result = await storageGet(['sessions', 'activeSessionId']);
  if (result.sessions && Array.isArray(result.sessions) && result.sessions.length > 0) {
    sessions = result.sessions;
    activeSessionId = result.activeSessionId || sessions[0].id;
    
    // If any session was running when popup closed, catch up on elapsed time
    const now = Date.now();
    sessions.forEach(session => {
      if (session.isRunning && !session.isPaused && session.startTime && session.lastSyncTime) {
        // Timer was running - calculate time elapsed while popup was closed
        const elapsedWhileClosed = now - session.lastSyncTime;
        session.accumulated += elapsedWhileClosed;
        if (!session.firstStartTime) session.firstStartTime = session.startTime; // safety net for older sessions
        session.startTime = now;  // Reset start time to now (working checkpoint only)
      }
    });
  } else {
    // Initialize with first session if none exist
    const firstSession = createSession();
    sessions = [firstSession];
    activeSessionId = firstSession.id;
    saveSessions();
  }
}

function loadSessionToForm() {
  const session = getActiveSession();
  if (!session) {
    resetFormFields();
    return;
  }
  
  document.getElementById("f-ticket").value = session.ticketNo || '';
  document.getElementById("f-client").value = session.clientName || '';
  document.getElementById("f-orders").value = session.numOrders || '';
  document.getElementById("f-ordernum").value = session.orderNumber || '';
  document.getElementById("f-comment").value = session.comment || '';
  
  if (session.ticketType) {
    selectedType = session.ticketType;
    document.getElementById("tt-badge").innerHTML = `<span class="sel-badge">${session.ticketType} ✓</span>`;
  } else {
    selectedType = '';
    document.getElementById("tt-badge").innerHTML = '';
  }
}

function resetFormFields() {
  document.getElementById("f-ticket").value  = "";
  document.getElementById("f-client").value  = "";
  document.getElementById("f-orders").value  = "";
  document.getElementById("f-ordernum").value = "";
  document.getElementById("f-comment").value = "";
  document.getElementById("tt-search").value = "";
  document.getElementById("tt-badge").innerHTML = "";
  selectedType = "";
}

// ══════════════ BACKGROUND SYNC ══════════════

let syncInterval = null;

function startBackgroundSync() {
  // Stop existing sync if any
  if (syncInterval) clearInterval(syncInterval);
  
  // Save session state periodically when timer is running
  syncInterval = setInterval(() => {
    const session = getActiveSession();
    if (session && session.isRunning) {
      // Update lastSyncTime and save
      session.lastSyncTime = Date.now();
      storageSet({
        sessions: sessions,
        activeSessionId: activeSessionId
      });
    }
  }, 5000);  // Save every 5 seconds while running
}

function stopBackgroundSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// ══════════════ TIMER ══════════════

function tickDisplay() {
  const session = getActiveSession();
  if (!session) {
    document.getElementById("t-disp").textContent = "00:00:00";
    return;
  }
  
  if (session.isRunning && !session.isPaused && session.startTime) {
    elapsed = session.accumulated + Date.now() - session.startTime;
  } else {
    elapsed = session.accumulated || 0;
  }
  document.getElementById("t-disp").textContent = fmt(elapsed);
}

function applyTimerStyle() {
  const session = getActiveSession();
  const d  = document.getElementById("t-disp");
  const sl = document.getElementById("t-slabel");
  
  if (!session) {
    tState = "idle";
  } else if (session.isRunning && session.isPaused) {
    tState = "paused";
  } else if (session.isRunning && !session.isPaused) {
    tState = "running";
  } else if (!session.isRunning && (session.accumulated || session.startTime)){
    tState = "stopped";
  } else {
    tState = "idle";
  }
  
  const cfg = {
    idle:    { color:"#2d2d5e", shadow:"none",                              label:"READY" },
    running: { color:"#a78bfa", shadow:"0 0 30px rgba(167,139,250,.4)",     label:"● RUNNING" },
    paused:  { color:"#f59e0b", shadow:"0 0 20px rgba(245,158,11,.3)",      label:"⏸ PAUSED" },
    stopped: { color:"#34d399", shadow:"0 0 20px rgba(52,211,153,.3)",      label:"■ STOPPED" },
  }[tState];
  d.style.color       = cfg.color;
  d.style.textShadow  = cfg.shadow;
  sl.style.color      = cfg.color;
  sl.textContent      = cfg.label;
}

function syncButtons() {
  const session = getActiveSession();
  const toggle = document.getElementById("btn-toggle");
  const submit = document.getElementById("tr-submit");

  if (!session || (!session.isRunning && !session.accumulated && !session.startTime)) {
    toggle.disabled = false;
    toggle.className = "btn btn-green";
    toggle.textContent = "▶ Start";
    submit.disabled = true;
  } else if (session && session.isRunning && !session.isPaused) {
    toggle.disabled = false;
    toggle.className = "btn btn-amber";
    toggle.textContent = "⏸ Pause";
    submit.disabled = false;
  } else if (session && session.isRunning && session.isPaused) {
    toggle.disabled = false;
    toggle.className = "btn btn-resume";
    toggle.textContent = "▶▶ Resume";
    submit.disabled = false;
  } else if (session && (!session.isRunning && session.accumulated || session.startTime)) {
    toggle.disabled = false;
    toggle.className = "btn btn-green";
    toggle.textContent = "▶ Start";
    submit.disabled = false;
  } else {
    toggle.disabled = false;
    toggle.className = "btn btn-green";
    toggle.textContent = "▶ Start";
    submit.disabled = true;
  }
}

function toggleTimer() {
  const session = getActiveSession();
  if (!session) return;
  
  if (!session.isRunning && !session.accumulated && !session.startTime) {
    // Idle - start timer
    session.startTime = Date.now();
    session.firstStartTime = session.startTime;   // record the true start, once
    session.lastSyncTime = session.startTime;
    session.isRunning = true;
    session.isPaused = false;
    playSound('start');
    startDisplayUpdate();
    startBackgroundSync();
  } else if (session.isRunning && !session.isPaused) {
    // Running - pause timer
    session.accumulated += Date.now() - session.startTime;
    session.pauseTimes.push(Date.now());
    session.isPaused = true;
    playSound('pause');
    stopDisplayUpdate();
    stopBackgroundSync();
  } else if (session.isRunning && session.isPaused) {
    // Paused - resume timer
    if (!session.firstStartTime) session.firstStartTime = session.startTime; // safety net for older sessions
    session.startTime = Date.now();
    session.lastSyncTime = session.startTime;
    session.resumeTimes.push(session.startTime);
    session.isPaused = false;
    playSound('resume');
    startDisplayUpdate();
    startBackgroundSync();
  } else if (!session.isRunning && (session.accumulated || session.startTime)) {
    // Stopped - restart timer (continuing the same entry, so keep the original start)
    if (!session.firstStartTime) session.firstStartTime = session.startTime || Date.now();
    session.startTime = Date.now();
    session.lastSyncTime = session.startTime;
    session.isRunning = true;
    session.isPaused = false;
    playSound('start');
    startDisplayUpdate();
    startBackgroundSync();
  }
  
  refreshDisplay();
  saveSessions();  // Persist to storage
}

function stopTimer() {
  const session = getActiveSession();
  if (!session || !session.isRunning) return;
  
  if (!session.isPaused) {
    session.accumulated += Date.now() - session.startTime;
  }
  session.stopTime = Date.now();
  session.isRunning = false;
  session.isPaused = false;
  
  playSound('stop');
  stopBackgroundSync();
  refreshDisplay();
  saveSessions();  // Persist to storage
}

function refreshDisplay() {
  applyTimerStyle();
  syncButtons();
  tickDisplay();
  renderTabs();
}

function startDisplayUpdate() {
  stopDisplayUpdate();
  displayInterval = setInterval(tickDisplay, 250);
}

function stopDisplayUpdate() {
  if (displayInterval) {
    clearInterval(displayInterval);
    displayInterval = null;
  }
}

// ══════════════ SHARED TEAM FOLDER SYNC ══════════════

// ══════════════ SUBMIT ══════════════

// Turn pasted order numbers (commas, spaces, or new lines between them)
// into a single clean comma-separated string for one Excel cell.
function normalizeOrderNumbers(raw) {
  return String(raw || '')
    .split(/[\s,;|]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .join(', ');
}

async function submitEntry() {
  if (!currentUser) return;
  
  const session = getActiveSession();
  if (!session) {
    flash("tr-msg", "⚠ No session active. Create a new one.", false);
    return;
  }

  const ticket  = document.getElementById("f-ticket").value.trim();
  const client  = document.getElementById("f-client").value.trim();
  const orders  = document.getElementById("f-orders").value.trim();
  const orderNumber = normalizeOrderNumbers(document.getElementById("f-ordernum").value);
  const comment = document.getElementById("f-comment").value.trim();

  if (!ticket || !client || !selectedType) {
    flash("tr-msg", "⚠ Fill in Ticket No., Client Name and Ticket Type.", false);
    return;
  }

  // Calculate final duration
  let totalDuration = session.accumulated;
  if (session.isRunning && !session.isPaused && session.startTime) {
    totalDuration += Date.now() - session.startTime;
  }

  if (totalDuration === 0) {
    flash("tr-msg", "⚠ Please track time before submitting.", false);
    return;
  }

  // Format timestamps in HH:MM:SS 24-hour format (local system time)
  // Format timestamps in HH:MM:SS 24-hour format (local system time)
  // Use the true session start (unaffected by pause/resume/reopen), falling back
  // to the working checkpoint only for sessions created before this field existed.
  const startTimeStr = (session.firstStartTime || session.startTime)
    ? formatTimeHHMMSS(session.firstStartTime || session.startTime)
    : '';
  const pauseTimesStr = session.pauseTimes.length > 0 
    ? session.pauseTimes.map(t => formatTimeHHMMSS(t)).join('; ')
    : '';
  const resumeTimesStr = session.resumeTimes.length > 0
    ? session.resumeTimes.map(t => formatTimeHHMMSS(t)).join('; ')
    : '';
  const stopTimeStr = session.stopTime ? formatTimeHHMMSS(session.stopTime) : formatTimeHHMMSS(Date.now());

  const entry = {
    id:         `${sanitizeFileSegment(currentUser.email || currentUser.name)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date:       new Date().toISOString().split("T")[0],
    userName:   currentUser.name,
    userEmail:  currentUser.email,
    ticketNo:   ticket,
    clientName: client,
    ticketType: selectedType,
    numOrders:  orders,
    orderNumber: orderNumber,
    duration:   fmt(totalDuration),
    durationMs: totalDuration,
    comment,
    startTime:  startTimeStr,
    pauseTimes: pauseTimesStr,
    resumeTimes: resumeTimesStr,
    stopTime:   stopTimeStr
  };

  const btn = document.getElementById("tr-submit");
  btn.disabled   = true;
  btn.textContent = "Submitting…";

  // Save to Chrome storage
  const result = await storageGet(['entries']);
  const local = result.entries || [];
  local.push(entry);
  await storageSet({ entries: local });
  
  // Add to recent tickets
  await addToRecent(entry);

  // Sync current user's file into the shared OneDrive folder if configured
  const syncResult = await syncCurrentUserEntriesToTeamFolder({ requestIfNeeded: true });

  flash("tr-msg", buildSubmitFlashMessage(syncResult), true);
  playSound('submit');

  btn.disabled   = false;
  btn.textContent = "■ Stop & Submit ✓";
  
  // Close current session and create new one
  sessions = sessions.filter(s => s.id !== session.id);
  if (sessions.length === 0) {
    newSession();
  } else {
    activeSessionId = sessions[0].id;
    loadSessionToForm();
  }
  
  renderTabs();
  refreshDisplay();
  saveSessions();  // Persist to storage
}

// ══════════════ ADMIN ══════════════

async function openAdmin() {
  setAdminStatus('Loading local and shared team data...', 'muted');
  await loadEntries({ requestIfNeeded: true });
  showScreen("admin");
}

async function loadEntries(options = {}) {
  const { requestIfNeeded = false } = options;
  const localEntries = await getLocalEntries();
  const syncSettings = await getSyncSettings();
  const teamResult = await loadTeamEntriesFromFolder({ requestIfNeeded });

  const mergedEntries = teamResult.ok
    ? dedupeEntries([...localEntries, ...teamResult.entries])
    : dedupeEntries(localEntries);

  window.allEntries = mergedEntries;
  allEntries = mergedEntries;

  if (teamResult.ok) {
    if (teamResult.fileCount > 0) {
      setAdminStatus(
        `Shared folder "${teamResult.folderName}" loaded. ${teamResult.fileCount} team files and ${mergedEntries.length} total records are visible.`,
        'success'
      );
    } else {
      setAdminStatus(
        `Shared folder "${teamResult.folderName}" is connected, but no team files were found yet. Showing local data only.`,
        'warn'
      );
    }
  } else if (syncSettings.sharedFolderName) {
    setAdminStatus(
      `Shared folder "${syncSettings.sharedFolderName}" is saved on this device, but access is not available right now. Reconnect it in Settings or click Refresh Team Data.`,
      'warn'
    );
  } else {
    setAdminStatus(
      'Showing local records only. Open Settings and choose the shared OneDrive folder for team visibility.',
      'warn'
    );
  }

  const users = [...new Set(window.allEntries.map(e => e.userName))];
  const sel   = document.getElementById("f-user");
  sel.innerHTML =
    `<option value="all">All Users (${users.length})</option>` +
    users.map(u => `<option value="${u}">${u}</option>`).join("");
  renderTable();
}

function getFiltered() {
  const fUser = document.getElementById("f-user").value;
  const q     = (document.getElementById("f-search").value || "").trim().toLowerCase();
  const from  = document.getElementById("f-date-from").value;
  const to    = document.getElementById("f-date-to").value;
  const entries = window.allEntries || [];
  // Entry dates are ISO (YYYY-MM-DD), so plain string comparison orders correctly.
  return entries.filter(e =>
    (fUser === "all" || e.userName === fUser) &&
    (!from || e.date >= from) &&
    (!to   || e.date <= to) &&
    (!q || Object.values(e).some(v => String(v ?? '').toLowerCase().includes(q)))
  );
}

function describeDateRange() {
  const from = document.getElementById("f-date-from").value;
  const to   = document.getElementById("f-date-to").value;
  if (from && to)  return `${from} → ${to}`;
  if (from)        return `from ${from}`;
  if (to)          return `until ${to}`;
  return "All";
}

function renderTable() {
  const data  = getFiltered();
  const users = new Set(data.map(e => e.userName));
  document.getElementById("s-total").textContent = data.length;
  document.getElementById("s-users").textContent = users.size;
  document.getElementById("s-date").textContent  = describeDateRange();

  const wrap = document.getElementById("ad-wrap");
  if (!data.length) {
    wrap.innerHTML = `<div class="empty"><div class="ei">📭</div>No records match filters</div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Date</th><th>Name</th><th>Ticket No</th><th>Ticket Type</th>
          <th>Orders</th><th>Order No.</th><th>Client</th><th>Duration</th><th>Comment</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${data.map(e => {
            const isOwner = !!(currentUser && (e.userEmail || '').toLowerCase() === currentUser.email.toLowerCase());
            return `<tr>
            <td>${e.date}</td>
            <td><span class="bp">${e.userName}</span></td>
            <td><span class="bb">${e.ticketNo}</span></td>
            <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.ticketType}</td>
            <td style="text-align:center">${e.numOrders || "—"}</td>
            <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.orderNumber || "—"}</td>
            <td>${e.clientName}</td>
            <td><span class="bg">${e.duration}</span></td>
            <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6b7280">${e.comment || "—"}</td>
            <td><div class="row-actions">
              <button class="row-act-btn row-act-edit" data-action="edit" data-id="${e.id}" title="Edit this ticket">✏️ Edit</button>
              <button class="row-act-btn row-act-delete" data-action="delete" data-id="${e.id}" ${isOwner ? '' : 'disabled'} title="${isOwner ? 'Delete this ticket' : `Only ${e.userName} can delete this ticket`}">🗑</button>
            </div></td>
          </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

// ──── Dashboard: Edit / Delete ────

function showEditDialog(entry) {
  const existing = document.getElementById('edit-dialog');
  if (existing) existing.remove();

  const typeOptions = TICKET_TYPES.map(t =>
    `<option value="${escapeHtml(t)}" ${t === entry.ticketType ? 'selected' : ''}>${escapeHtml(t)}</option>`
  ).join('');

  const dialogHTML = `
    <div id="edit-dialog">
      <div class="edit-box">
        <div class="edit-title">✏️ Edit Ticket — ${escapeHtml(entry.userName)}</div>
        <div class="edit-field">
          <label>Ticket No.</label>
          <input type="text" id="ed-ticket" value="${escapeHtml(entry.ticketNo)}" />
        </div>
        <div class="edit-field">
          <label>Client Name</label>
          <input type="text" id="ed-client" value="${escapeHtml(entry.clientName)}" />
        </div>
        <div class="edit-field">
          <label>Ticket Type</label>
          <select id="ed-type">${typeOptions}</select>
        </div>
        <div class="edit-field">
          <label>Number of Orders</label>
          <input type="number" id="ed-orders" min="0" value="${escapeHtml(entry.numOrders)}" />
        </div>
        <div class="edit-field">
          <label>Order Number</label>
          <input type="text" id="ed-ordernum" value="${escapeHtml(entry.orderNumber)}" />
        </div>
        <div class="edit-field">
          <label>Comment</label>
          <textarea id="ed-comment">${escapeHtml(entry.comment)}</textarea>
        </div>
        <div class="edit-buttons">
          <button id="ed-cancel" class="edit-btn edit-btn-cancel">Cancel</button>
          <button id="ed-save" class="edit-btn edit-btn-save">Save Changes</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', dialogHTML);
  const dialog = document.getElementById('edit-dialog');

  document.getElementById('ed-cancel').addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });

  document.getElementById('ed-save').addEventListener('click', async () => {
    const updates = {
      ticketNo:    document.getElementById('ed-ticket').value.trim(),
      clientName:  document.getElementById('ed-client').value.trim(),
      ticketType:  document.getElementById('ed-type').value,
      numOrders:   document.getElementById('ed-orders').value.trim(),
      orderNumber: normalizeOrderNumbers(document.getElementById('ed-ordernum').value),
      comment:     document.getElementById('ed-comment').value.trim()
    };
    if (!updates.ticketNo || !updates.clientName || !updates.ticketType) {
      setAdminStatus('⚠ Ticket No., Client Name and Ticket Type cannot be empty.', 'warn');
      return;
    }

    const saveBtn = document.getElementById('ed-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    const result = await saveEditedEntry(entry, updates);
    dialog.remove();

    setAdminStatus(
      result.ok
        ? `✓ Ticket "${updates.ticketNo}" updated and saved to ${entry.userName}'s file.`
        : `⚠ Could not save the edit (${result.reason || 'unknown error'}). Reconnect the shared folder in Settings and try again.`,
      result.ok ? 'success' : 'warn'
    );
    renderTable();
  });
}

async function saveEditedEntry(entry, updates) {
  Object.assign(entry, updates);

  const ownerEmail = entry.userEmail;
  const ownerName  = entry.userName;
  const ownerFullList = (window.allEntries || []).filter(e =>
    (e.userEmail || '').toLowerCase() === (ownerEmail || '').toLowerCase()
  );

  const result = await writeExactEntriesForOwner(ownerEmail, ownerName, ownerFullList, { requestIfNeeded: true });

  // If the edited ticket is the signed-in user's own, keep local storage (their
  // own device cache) in sync too — otherwise their next submit would re-push
  // the old values and race against this edit.
  if (result.ok && currentUser && (ownerEmail || '').toLowerCase() === currentUser.email.toLowerCase()) {
    const local = await getLocalEntries();
    const idx = local.findIndex(e => e.id === entry.id);
    if (idx !== -1) {
      local[idx] = { ...local[idx], ...updates };
      await storageSet({ entries: local });
    }
  }

  return result;
}

function confirmDeleteEntry(entry) {
  if (!currentUser || (entry.userEmail || '').toLowerCase() !== currentUser.email.toLowerCase()) {
    setAdminStatus(`⚠ Only ${entry.userName} can delete this ticket.`, 'warn');
    return;
  }
  showConfirmDialog(
    'Delete this ticket?',
    `"${entry.ticketNo}" for ${entry.clientName} will be permanently removed from your team file. This can't be undone.`,
    () => deleteEntryNow(entry),
    () => {}
  );
}

async function deleteEntryNow(entry) {
  const ownerFullList = (window.allEntries || []).filter(e =>
    e.id !== entry.id && (e.userEmail || '').toLowerCase() === currentUser.email.toLowerCase()
  );

  const result = await writeExactEntriesForOwner(currentUser.email, currentUser.name, ownerFullList, { requestIfNeeded: true });

  if (result.ok) {
    const local = await getLocalEntries();
    await storageSet({ entries: local.filter(e => e.id !== entry.id) });
    window.allEntries = (window.allEntries || []).filter(e => e.id !== entry.id);
  }

  setAdminStatus(
    result.ok
      ? `✓ Ticket "${entry.ticketNo}" deleted.`
      : `⚠ Could not delete (${result.reason || 'unknown error'}). Reconnect the shared folder in Settings and try again.`,
    result.ok ? 'success' : 'warn'
  );
  renderTable();
}

function clearFilters() {
  document.getElementById("f-user").value = "all";
  document.getElementById("f-search").value = "";
  document.getElementById("f-date-from").value = "";
  document.getElementById("f-date-to").value = "";
  renderTable();
}

function downloadCSV() {
  const data = getFiltered();
  if (!data.length) { alert("No records to export."); return; }

  const headers = ["Date","Name","Ticket No","Ticket Type","No. of Orders","Order Number","Client Name","Total Duration","Start Time","Pause Times","Resume Times","End Time","Comment"];
  const rows    = data.map(e => [
    e.date, e.userName, e.ticketNo, e.ticketType,
    e.numOrders || "", e.orderNumber || "", e.clientName, e.duration, 
    e.startTime || "", e.pauseTimes || "", e.resumeTimes || "", e.stopTime || "",
    e.comment || ""
  ]);

  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const fUser = document.getElementById("f-user").value;
  const from = document.getElementById("f-date-from").value;
  const to   = document.getElementById("f-date-to").value;
  const fDate = from || to ? `${from || 'start'}_to_${to || 'today'}` : "";
  const fname = `QC_Tracker_${fUser === "all" ? "All_Users" : fUser}${fDate ? "_" + fDate : ""}.csv`;

  const a  = document.createElement("a");
  a.href   = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ══════════════ SETTINGS ══════════════

async function openSettings() {
  await loadSettingsForm();
  showScreen("settings");
}

async function loadSettingsForm() {
  let syncSettings = await getSyncSettings();
  const folderName = syncSettings.sharedFolderName || '';
  const savedHandle = await getStoredTeamFolderHandle();
  const folderInput = document.getElementById('shared-folder-name');
  const memberFileName = currentUser ? getMemberSyncFileName(currentUser) : (syncSettings.memberFileName || '');

  if (memberFileName && syncSettings.memberFileName !== memberFileName) {
    syncSettings = await saveSyncSettings({ memberFileName });
  }

  if (folderInput) {
    folderInput.value = folderName;
  }

  updateTeamFileHint(memberFileName);
  renderSyncMeta({ ...syncSettings, memberFileName });

  if (!isFolderSyncSupported()) {
    setFolderStatus('<span style="color:#ef4444">❌ This browser does not support shared-folder sync.</span>');
    document.getElementById('regrant-access-btn').style.display = 'none';
  } else if (!savedHandle || !folderName) {
    setFolderStatus('<span style="color:#6b7280">No shared folder selected yet. Follow the setup steps above.</span>');
    document.getElementById('regrant-access-btn').style.display = 'none';
  } else {
    const permission = await queryHandlePermission(savedHandle, true);
    if (permission === 'granted') {
      setFolderStatus(`<span style="color:#34d399">✓ Connected to shared folder: ${folderName}</span>`);
      // Keep re-grant button visible as a reminder — permission resets on browser restart
      document.getElementById('regrant-access-btn').style.display = 'block';
    } else {
      setFolderStatus(`<span style="color:#f59e0b">⚠️ Folder saved but access has expired (normal after browser restart). Click "Re-grant Folder Access" below.</span>`);
      document.getElementById('regrant-access-btn').style.display = 'block';
    }
  }

  document.getElementById('sound-toggle').checked = settings.soundEnabled;
  document.getElementById('notif-toggle').checked = settings.notificationsEnabled;
}

async function chooseSharedFolder() {
  if (!isFolderSyncSupported()) {
    setFolderStatus('<span style="color:#ef4444">❌ This browser cannot open the folder picker. Use Chrome or Microsoft Edge on desktop.</span>');
    return;
  }

  // The native folder picker steals focus and closes the small popup, which
  // cancels the selection. Open a full tab and let the user pick there.
  if (!isRunningInTab()) {
    setFolderStatus('<span style="color:#f59e0b">⚠️ The folder picker closes the small popup. Opening a full tab — in that tab, click <b>📁 Choose Shared Folder</b>.</span>');
    openInTab();
    return;
  }

  try {
    const handle = await window.showDirectoryPicker();
    if (!handle) {
      setFolderStatus('<span style="color:#f59e0b">⚠️ No folder selected. Please try again.</span>');
      return;
    }
    
    // Ensure read/write permission
    const granted = await ensureHandlePermission(handle, true);

    if (!granted) {
      setFolderStatus('<span style="color:#f59e0b">⚠️ Folder selected, but read/write access was not granted. Try clicking "Re-grant Folder Access" button below.</span>');
      // Store the handle anyway so user can re-grant later
      try {
        await setStoredTeamFolderHandle(handle);
        const syncSettings = await getSyncSettings();
        await saveSyncSettings({
          mode: 'shared-onedrive-folder',
          sharedFolderName: handle.name,
          memberFileName: currentUser ? getMemberSyncFileName(currentUser) : '',
          configuredAt: new Date().toISOString()
        });
        document.getElementById('regrant-access-btn').style.display = 'block';
      } catch (e) {
        console.warn('Could not store partial folder handle:', e);
      }
      return;
    }

    const memberFileName = currentUser ? getMemberSyncFileName(currentUser) : '';
    // Store handle first
    await setStoredTeamFolderHandle(handle);
    // Then update settings with full access granted
    await saveSyncSettings({
      mode: 'shared-onedrive-folder',
      sharedFolderName: handle.name,
      memberFileName,
      accessGranted: true,
      configuredAt: new Date().toISOString()
    });

    await loadSettingsForm();

    const resultEl = document.getElementById('test-result');
    const syncResult = await syncCurrentUserEntriesToTeamFolder({ requestIfNeeded: true, allowEmpty: true });
    if (resultEl) {
      resultEl.innerHTML = syncResult.ok
        ? `<span style="color:#34d399">✓ Folder connected. Your team file is ready: ${syncResult.fileName}</span>`
        : '<span style="color:#34d399">✓ Folder connected. Submit an entry to create your team file.</span>';
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      // In a popup the dialog may close the popup itself — guide user to open in tab
      if (!isRunningInTab()) {
        setFolderStatus('<span style="color:#f59e0b">⚠️ The folder picker was cancelled. If the popup keeps closing, click <b>Open in Full Tab</b> below and try from there.</span>');
      } else {
        setFolderStatus('<span style="color:#f59e0b">⚠️ Folder selection was cancelled. Please try again.</span>');
      }
      return;
    }
    if (error && error.name === 'SecurityError') {
      setFolderStatus('<span style="color:#ef4444">❌ Access denied. Make sure the folder is synced to your PC and you have permission to access it.</span>');
      return;
    }
    setFolderStatus(`<span style="color:#ef4444">❌ Could not connect folder: ${error?.message || 'Unknown error'}</span>`);
  }
}

async function syncExistingDataToTeamFolder() {
  const resultEl = document.getElementById('test-result');
  if (resultEl) {
    resultEl.innerHTML = '<span style="color:#6b7280">Syncing your local entries into the shared folder...</span>';
  }

  if (!currentUser) {
    if (resultEl) {
      resultEl.innerHTML = '<span style="color:#ef4444">❌ Sign in first so the extension knows which team file to update.</span>';
    }
    return;
  }

  const syncResult = await syncCurrentUserEntriesToTeamFolder({ requestIfNeeded: true, allowEmpty: true });
  await loadSettingsForm();

  if (!resultEl) return;

  if (syncResult.ok) {
    resultEl.innerHTML = `<span style="color:#34d399">✓ Shared folder updated. ${syncResult.entryCount} records are in ${syncResult.fileName}.</span>`;
    playSound('submit');
    return;
  }

  if (syncResult.reason === 'no-local-entries') {
    resultEl.innerHTML = '<span style="color:#f59e0b">⚠️ Folder is connected, but there are no local entries yet for this user.</span>';
  } else if (syncResult.reason === 'folder-not-ready') {
    resultEl.innerHTML = '<span style="color:#ef4444">❌ Choose the shared OneDrive folder first, then sync again.</span>';
  } else {
    resultEl.innerHTML = '<span style="color:#ef4444">❌ Could not update the shared folder from this device.</span>';
  }
}

async function clearSharedFolder() {
  if (!confirm('Are you sure? This will stop shared team sync on this device.')) {
    return;
  }

  await removeStoredTeamFolderHandle();
  await saveSyncSettings({
    mode: 'shared-onedrive-folder',
    sharedFolderName: '',
    memberFileName: '',
    lastWriteAt: '',
    lastReadAt: ''
  });

  const folderInput = document.getElementById('shared-folder-name');
  if (folderInput) folderInput.value = '';
  setFolderStatus('<span style="color:#6b7280">Shared folder cleared on this device.</span>');
  updateTeamFileHint('');
  renderSyncMeta({});

  const resultEl = document.getElementById('test-result');
  if (resultEl) resultEl.innerHTML = '';
}

async function testSharedFolderAccess() {
  const resultEl = document.getElementById('test-result');
  const btnTest = document.getElementById('btn-test-folder');

  if (btnTest) {
    btnTest.disabled = true;
    btnTest.textContent = '⏳ Checking...';
  }
  if (resultEl) {
    resultEl.innerHTML = '<span style="color:#6b7280">Running a real read/write test on the shared folder…</span>';
  }

  try {
    const diag = await diagnoseSharedFolder();

    if (diag.code === 'ok') {
      // Folder proven writable — now actually create/refresh this member's team file.
      const syncResult = await syncCurrentUserEntriesToTeamFolder({ requestIfNeeded: true, allowEmpty: true });
      await loadSettingsForm();
      if (resultEl) {
        resultEl.innerHTML = syncResult.ok
          ? `<span style="color:#34d399">✓ All good. The folder is writable and synced. Your team file: <b>${syncResult.fileName}</b></span>`
          : `<span style="color:#34d399">✓ Folder access works. Submit an entry to create your team file.</span>`;
      }
      playSound('submit');
      return;
    }

    await loadSettingsForm();
    if (!resultEl) return;

    const messages = {
      'not-signed-in':
        '❌ <b>Sign in first.</b> The extension needs your name + email to name your team file. Go back, sign in, then test again.',
      'unsupported':
        '❌ <b>This browser can\'t do folder sync.</b> Use Google Chrome or Microsoft Edge (desktop). If you\'re already in Chrome, click <b>🔗 Open in Full Tab</b> and try from there.',
      'no-folder':
        '❌ <b>No folder connected on this PC yet.</b> Click <b>📁 Choose Shared Folder</b> and pick the team folder inside your local OneDrive.',
      'need-permission':
        `⚠️ <b>Chrome needs you to allow access again.</b> This is normal after restarting Chrome. Click <b>🔑 Re-grant Folder Access</b> above and choose <b>Allow</b>. (Folder: ${diag.folderName || '—'})`,
      'write-blocked':
        '❌ <b>The folder is connected but the extension can\'t write into it.</b> This is almost always one of these — fix whichever applies:' +
        '<div style="margin:8px 0 0;padding:10px 12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);border-radius:8px;line-height:1.7">' +
        '<b>1. The folder was shared "Can view", not "Can edit".</b><br>Ask the admin to re-share it with <b>Can edit</b> for you, then remove and re-add the shortcut.<br><br>' +
        '<b>2. The folder is online-only (cloud icon).</b><br>In File Explorer → OneDrive, right-click the team folder → <b>"Always keep on this device"</b>. Wait for the green check, then test again.<br><br>' +
        '<b>3. You picked the wrong folder.</b><br>Make sure you selected the folder <i>inside</i> File Explorer → OneDrive — not a OneDrive-web "Shared" page.' +
        '</div>' +
        (diag.detail ? `<div style="margin-top:6px;font-size:10px;color:#6b7280">Technical detail: ${diag.errName} ${diag.detail}</div>` : '')
    };

    resultEl.innerHTML = `<span style="color:${diag.code === 'need-permission' ? '#f59e0b' : '#ef4444'}">${messages[diag.code] || '❌ Could not access the shared folder.'}</span>`;
  } finally {
    if (btnTest) {
      btnTest.disabled = false;
      btnTest.textContent = '🧪 Test Folder Access';
    }
  }
}

// ══════════════ KEYBOARD SHORTCUTS ══════════════

document.addEventListener('keydown', (e) => {
  // Escape to close dropdowns
  if (e.key === 'Escape') {
    closeDrop();
  }
});

// ══════════════ INIT ══════════════

function attachEventListeners() {
  // Login screen
  const btnLogin = document.getElementById('btn-login');
  if (btnLogin) btnLogin.addEventListener('click', doLogin);
  
  // Tracker screen
  document.querySelectorAll('.theme-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      settings.theme = sw.dataset.themeChoice;
      applyTheme();
      storageSet({ settings: settings });
    });
  });
  
  const btnAdmin = document.getElementById('btn-admin');
  if (btnAdmin) btnAdmin.addEventListener('click', () => {
    // The dashboard needs real room for the table and its Edit/Delete actions,
    // so it always opens in its own full browser tab rather than the small popup.
    if (!isRunningInTab()) { openInTab('#admin'); return; }
    openAdmin();
  });
  
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.addEventListener('click', openSettings);
  
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) btnLogout.addEventListener('click', doLogout);
  
  const btnToggle = document.getElementById('btn-toggle');
  if (btnToggle) btnToggle.addEventListener('click', toggleTimer);
  
  const btnSubmit = document.getElementById('tr-submit');
  if (btnSubmit) btnSubmit.addEventListener('click', submitEntry);
  
  const btnNewTab = document.getElementById('btn-new-tab');
  if (btnNewTab) btnNewTab.addEventListener('click', newSession);
  
  // Real-time tab label update on ticket number change (with debounce to reduce storage writes)
  const fTicket = document.getElementById('f-ticket');
  if (fTicket) {
    let ticketSaveTimeout = null;
    fTicket.addEventListener('input', () => {
      const session = getActiveSession();
      if (session) {
        session.ticketNo = fTicket.value.trim();
        renderTabs();
        // Debounce storage writes to avoid excessive I/O
        clearTimeout(ticketSaveTimeout);
        ticketSaveTimeout = setTimeout(() => {
          saveSessions();
        }, 500);

        // Auto-start the timer the moment a ticket number is entered, if it
        // isn't already running/paused/stopped for this session. Pause and
        // Resume stay fully manual — this only replaces the initial Start click.
        if (session.ticketNo && !session.isRunning && !session.accumulated && !session.startTime) {
          toggleTimer();
        }
      }
    });
  }
  
  // Save session data when other form fields change (on blur to reduce storage writes)
  const formFields = [
    'f-client', 'f-orders', 'f-comment', 'f-ordernum'
  ];
  formFields.forEach(fieldId => {
    const field = document.getElementById(fieldId);
    if (field) {
      field.addEventListener('blur', () => {
        const session = getActiveSession();
        if (session) {
          session.clientName = document.getElementById('f-client').value.trim();
          session.numOrders = document.getElementById('f-orders').value.trim();
          session.orderNumber = normalizeOrderNumbers(document.getElementById('f-ordernum').value);
          session.comment = document.getElementById('f-comment').value.trim();
          saveSessions();
        }
      });
    }
  });

  // Order Number: tidy the pasted value into clean comma-separated form on blur
  const fOrderNum = document.getElementById('f-ordernum');
  if (fOrderNum) {
    fOrderNum.addEventListener('blur', () => {
      const cleaned = normalizeOrderNumbers(fOrderNum.value);
      fOrderNum.value = cleaned;
      const session = getActiveSession();
      if (session) { session.orderNumber = cleaned; saveSessions(); }
    });
  }
  
  // Dropdown
  const ttSearch = document.getElementById("tt-search");
  if (ttSearch) {
    ttSearch.addEventListener("input", () => renderDrop(ttSearch.value));
    ttSearch.addEventListener("focus", openDrop);
  }
  document.addEventListener("click", e => {
    if (!e.target.closest("#dd-wrap")) closeDrop();
  });
  setupDropdownDelegation();
  
  // Admin screen
  const btnBack = document.getElementById('btn-back');
  if (btnBack) btnBack.addEventListener('click', () => showScreen('tracker'));
  
  const btnClear = document.getElementById('btn-clear');
  if (btnClear) btnClear.addEventListener('click', clearFilters);

  const btnRefreshTeam = document.getElementById('btn-refresh-team');
  if (btnRefreshTeam) {
    btnRefreshTeam.addEventListener('click', () => {
      loadEntries({ requestIfNeeded: true });
    });
  }
  
  const btnCSV = document.getElementById('btn-csv');
  if (btnCSV) btnCSV.addEventListener('click', downloadCSV);
  
  const fUser = document.getElementById('f-user');
  if (fUser) fUser.addEventListener('change', renderTable);
  
  const fSearch = document.getElementById('f-search');
  if (fSearch) fSearch.addEventListener('input', renderTable);
  const fDateFrom = document.getElementById('f-date-from');
  if (fDateFrom) fDateFrom.addEventListener('input', renderTable);
  const fDateTo = document.getElementById('f-date-to');
  if (fDateTo) fDateTo.addEventListener('input', renderTable);

  // Row actions (Edit / Delete) — one delegated listener survives every
  // renderTable() redraw, since the buttons themselves are rebuilt each time.
  const adWrap = document.getElementById('ad-wrap');
  if (adWrap) {
    adWrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.row-act-btn');
      if (!btn || btn.disabled) return;
      const id = btn.dataset.id;
      const entry = (window.allEntries || []).find(x => x.id === id);
      if (!entry) return;
      if (btn.dataset.action === 'edit') showEditDialog(entry);
      else if (btn.dataset.action === 'delete') confirmDeleteEntry(entry);
    });
  }
  
  // Settings screen
  const btnBackSettings = document.getElementById('btn-back-settings');
  if (btnBackSettings) btnBackSettings.addEventListener('click', () => showScreen('tracker'));

  const btnPickFolder = document.getElementById('btn-pick-folder');
  if (btnPickFolder) btnPickFolder.addEventListener('click', chooseSharedFolder);

  const btnSyncFolder = document.getElementById('btn-sync-folder');
  if (btnSyncFolder) btnSyncFolder.addEventListener('click', syncExistingDataToTeamFolder);

  const btnClearFolder = document.getElementById('btn-clear-folder');
  if (btnClearFolder) btnClearFolder.addEventListener('click', clearSharedFolder);

  const btnTestFolder = document.getElementById('btn-test-folder');
  if (btnTestFolder) btnTestFolder.addEventListener('click', testSharedFolderAccess);

  const btnOpenInTab = document.getElementById('btn-open-in-tab');
  if (btnOpenInTab) btnOpenInTab.addEventListener('click', openInTab);
  
  const soundToggle = document.getElementById('sound-toggle');
  if (soundToggle) {
    soundToggle.addEventListener('change', () => {
      settings.soundEnabled = soundToggle.checked;
      storageSet({ settings: settings });
    });
  }
  
  const notifToggle = document.getElementById('notif-toggle');
  if (notifToggle) {
    notifToggle.addEventListener('change', () => {
      settings.notificationsEnabled = notifToggle.checked;
      storageSet({ settings: settings });
    });
  }

  const btnTestNotif = document.getElementById('btn-test-notif');
  if (btnTestNotif) {
    btnTestNotif.addEventListener('click', () => {
      const resultEl = document.getElementById('test-notif-result');
      if (typeof chrome === 'undefined' || !chrome.notifications || !chrome.notifications.create) {
        if (resultEl) resultEl.innerHTML = '<span style="color:#ef4444">❌ This browser build has no notifications API available to the extension.</span>';
        return;
      }
      chrome.notifications.create('qc-test-notif', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '🔔 QC Time Tracker — test notification',
        message: 'If you can see this, notifications are working correctly on this PC.',
        priority: 2
      }, (notificationId) => {
        if (!resultEl) return;
        if (chrome.runtime.lastError || !notificationId) {
          resultEl.innerHTML = `<span style="color:#ef4444">❌ The browser rejected the notification: ${chrome.runtime.lastError ? chrome.runtime.lastError.message : 'unknown error'}. Try reloading the extension in edge://extensions.</span>`;
        } else {
          resultEl.innerHTML = '<span style="color:#34d399">✓ Sent. If nothing appeared on screen in the next few seconds, notifications are being blocked outside the extension — check Windows Settings → System → Notifications → your browser is turned on, and that Focus Assist / Do Not Disturb is off.</span>';
        }
      });
    });
  }
}

async function init() {
  try {
    console.log('Initializing QC Time Tracker...');

    // Detect tab mode (full browser tab vs small popup)
    if (window.innerWidth > 500) {
      document.body.classList.add('tab-mode');
    }
    
    // Load sessions from storage first
    await loadSessions();
    
    // Attach all event listeners
    attachEventListeners();
    
    // Load settings
    let result = {};
    try {
      result = await storageGet(['settings', 'qc-user']) || {};
    } catch (e) {
      console.warn('Could not retrieve storage:', e);
    }
    
    if (result.settings) {
      settings = { ...settings, ...result.settings };
    }
    applyTheme();
    
    // Load user session
    if (result['qc-user'] && result['qc-user'].name) {
      currentUser = result['qc-user'];
      const userDisplay = document.getElementById("tr-user");
      if (userDisplay) {
        userDisplay.textContent = "👤 " + currentUser.name;
      }
      showScreen("tracker");
    } else {
      showScreen("login");
    }
    
    // Load active session data into form
    loadSessionToForm();
    
    // Load recent tickets
    try {
      await loadRecentTickets();
    } catch (e) {
      console.warn('Could not load recent tickets:', e);
    }
    
    renderDrop();
    renderTabs();
    syncButtons();

    // If opened via "Open in Full Tab" (popup.html?tab=1#settings), jump
    // straight to Settings so Re-grant / Choose Folder is one click away.
    if (currentUser && location.hash === '#settings') {
      try { await openSettings(); } catch (e) { console.warn('Auto-open settings failed:', e); }
    } else if (currentUser && location.hash === '#admin') {
      try { await openAdmin(); } catch (e) { console.warn('Auto-open dashboard failed:', e); }
    }

    // If timer is running, restore display updates and background sync
    const session = getActiveSession();
    if (session && session.isRunning && !session.isPaused) {
      // Timer was running when popup closed - restore display
      refreshDisplay();  // Update display immediately
      startDisplayUpdate();
      startBackgroundSync();
    }
    
    console.log('Initialization complete');
  } catch (err) {
    console.error('Init error:', err);
  }
}

// Run init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Add re-grant button handler
function setupRegrantButton() {
  const btnRegrant = document.getElementById('btn-regrant-access');
  if (!btnRegrant) return;
  // Guard against attaching the listener every time Settings opens —
  // stacked listeners would fire multiple permission prompts on one click.
  if (btnRegrant.dataset.wired === '1') return;
  btnRegrant.dataset.wired = '1';

  btnRegrant.addEventListener('click', async () => {
    // The native "Allow" prompt steals focus, which closes the small extension
    // popup and cancels the request (this is the usual "not granted" loop).
    // Force re-grant into a full tab where the prompt can stay open.
    if (!isRunningInTab()) {
      setFolderStatus('<span style="color:#f59e0b">⚠️ The permission prompt closes the small popup. Opening a full tab — click <b>🔑 Re-grant Folder Access</b> there, then choose <b>Edit</b> when the prompt appears.</span>');
      openInTab();
      return;
    }

    btnRegrant.disabled = true;
    btnRegrant.textContent = '⏳ Choose “Edit” in the prompt…';

    try {
      // Use the cached handle if we have it, so requestPermission() runs
      // inside this click's user activation (no IndexedDB await first).
      let handle = cachedFolderHandle;
      if (!handle) handle = await getStoredTeamFolderHandle();

      if (!handle) {
        setFolderStatus('<span style="color:#f59e0b">⚠️ No folder is connected yet. Click <b>📁 Choose Shared Folder</b> below and pick OneDrive → your team folder.</span>');
        return;
      }

      let result = 'denied';
      try {
        result = await handle.requestPermission({ mode: 'readwrite' });
      } catch (e) {
        console.warn('requestPermission threw:', e);
        result = 'denied';
      }

      if (result === 'granted') {
        setFolderStatus('<span style="color:#34d399">✓ Access granted. The shared folder is ready — you can close this tab.</span>');
        playSound('submit');
        await loadSettingsForm();
      } else {
        setFolderStatus('<span style="color:#f59e0b">⚠️ The prompt was dismissed or set to “View only.” Click the button again and choose <b>Edit</b>. If no prompt appears at all, click <b>📁 Choose Shared Folder</b> to re-select the folder.</span>');
      }
    } catch (e) {
      setFolderStatus(`<span style="color:#ef4444">❌ Error re-granting access: ${e?.message || 'Unknown error'}</span>`);
    } finally {
      btnRegrant.disabled = false;
      btnRegrant.textContent = '🔑 Re-grant Folder Access';
    }
  });
}

// Hook re-grant button when settings screen loads
const originalOpenSettings = openSettings;
openSettings = async function() {
  await originalOpenSettings.call(this);
  setupRegrantButton();
};

// Clean up when popup closes
window.addEventListener('beforeunload', () => {
  stopDisplayUpdate();  // Stop display interval
  stopBackgroundSync();  // Stop background sync
  saveSessions();  // Final save before closing
});
