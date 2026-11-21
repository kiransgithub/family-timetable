// In-app alerts while the app is open: a popup, a chime, and a system
// notification when allowed. Background alerts come from the calendar feed.

import { upcomingAlerts } from '../core/alerts.js';

const FIRED_KEY = 'ftm.fired';

function loadFired() {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_KEY) || '{}');
    const cutoff = Date.now() - 2 * 86400000;
    return new Map(Object.entries(raw).filter(([, t]) => t > cutoff));
  } catch {
    return new Map();
  }
}

export class AlertScheduler {
  constructor({ getDb, now, onFire }) {
    this.getDb = getDb;
    this.now = now;
    this.onFire = onFire;
    this.fired = loadFired();
    this.snoozed = [];
    this.timer = null;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.tick();
    });
  }

  save() {
    try {
      localStorage.setItem(FIRED_KEY, JSON.stringify(Object.fromEntries(this.fired)));
    } catch {
      /* storage full or blocked: alerts may repeat, which is harmless */
    }
  }

  upcoming() {
    const db = this.getDb();
    return db ? upcomingAlerts(db, this.now()) : [];
  }

  snooze(alert, minutes = 5) {
    this.snoozed.push({ ...alert, id: `${alert.id}:snooze:${Date.now()}`, atMs: this.now() + minutes * 60000, snoozed: true });
  }

  tick() {
    const db = this.getDb();
    if (!db) return;
    const now = this.now();
    const due = [];
    // Fire anything that came due in the last 15 minutes (covers a phone that was asleep).
    for (const a of upcomingAlerts(db, now, 15)) {
      if (a.atMs <= now && !this.fired.has(a.id)) due.push(a);
    }
    this.snoozed = this.snoozed.filter((a) => {
      if (a.atMs <= now) {
        due.push(a);
        return false;
      }
      return true;
    });
    if (!due.length) return;
    for (const a of due) this.fired.set(a.id, now);
    this.save();
    for (const a of due) this.onFire(a);
  }
}

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestNotifications() {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

export async function showSystemNotification(alert) {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  const opts = { body: alert.body, tag: alert.id, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: `#/today/${alert.occurrence?.date || ''}` } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(alert.title, opts);
      return true;
    }
    new Notification(alert.title, opts); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

let audioCtx = null;
export function unlockAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

export function chime() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  [880, 1175].forEach((freq, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t + i * 0.22);
    g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.22 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.22 + 0.5);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + i * 0.22);
    o.stop(t + i * 0.22 + 0.55);
  });
}
