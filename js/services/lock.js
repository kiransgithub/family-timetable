// Who is unlocked for rewards changes on this device, and until when. The
// unlock itself is kept in memory only: a reload, the app going to the
// background, or the timer running out locks it again. Repeated wrong
// passwords slow down retries, and that count survives a reload.

const FAILS_KEY = 'ftm.rewards.fails';

let session = { parent: null, until: 0 };
let timer = null;
const listeners = new Set();

function readFails() {
  try {
    const v = JSON.parse(localStorage.getItem(FAILS_KEY) || 'null');
    return { fails: Number(v?.fails) || 0, blockedUntil: Number(v?.blockedUntil) || 0 };
  } catch {
    return { fails: 0, blockedUntil: 0 };
  }
}

function writeFails(v) {
  try {
    if (!v.fails) localStorage.removeItem(FAILS_KEY);
    else localStorage.setItem(FAILS_KEY, JSON.stringify(v));
  } catch {
    /* storage may be unavailable */
  }
}

function emit() {
  for (const fn of listeners) fn();
}

export function onLockChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function lock() {
  const was = session.parent;
  session = { parent: null, until: 0 };
  clearTimeout(timer);
  if (was) emit();
}

function arm() {
  clearTimeout(timer);
  timer = setTimeout(lock, Math.max(0, session.until - Date.now()) + 50);
}

export function currentParent() {
  if (session.parent && Date.now() < session.until) return session.parent;
  if (session.parent) lock();
  return null;
}

export function unlock(parentId, minutes) {
  session = { parent: parentId, until: Date.now() + minutes * 60000 };
  writeFails({ fails: 0, blockedUntil: 0 });
  arm();
  emit();
}

// Each change made while unlocked restarts the countdown.
export function extend(minutes) {
  if (!currentParent()) return;
  session.until = Date.now() + minutes * 60000;
  arm();
  emit();
}

export function secondsLeft() {
  return currentParent() ? Math.max(0, Math.round((session.until - Date.now()) / 1000)) : 0;
}

export function waitSeconds() {
  return Math.max(0, Math.ceil((readFails().blockedUntil - Date.now()) / 1000));
}

// After 5 wrong tries: wait 30 s, then 1, 2, 4 and at most 8 minutes.
export function recordFailure() {
  const v = readFails();
  v.fails += 1;
  if (v.fails >= 5) v.blockedUntil = Date.now() + 30000 * 2 ** Math.min(v.fails - 5, 4);
  writeFails(v);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') lock();
  });
}
