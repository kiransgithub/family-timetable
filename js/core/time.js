// Date and time helpers shared by the browser app and the Node tools.
// Calendar dates are 'YYYY-MM-DD' strings in the family's time zone and
// times of day are minutes after midnight, so nothing depends on the time
// zone of the device that happens to be running the code.

export const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const DOW_SHORT = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };
export const DOW_LONG = { SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday' };
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const pad2 = (n) => String(n).padStart(2, '0');

export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const isHM = (s) => typeof s === 'string' && HM_RE.test(s);

export function hmToMin(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

export function minToHM(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export function fmt12(min) {
  if (min == null || Number.isNaN(min)) return 'TBD';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${pad2(m % 60)} ${h < 12 ? 'AM' : 'PM'}`;
}

// "6:30–7:00 PM", or "11:30 AM–12:30 PM" when the halves differ.
export function fmtRange(a, b) {
  if (a == null) return 'Time TBD';
  if (b == null || b === a) return fmt12(a);
  const s = fmt12(a);
  const e = fmt12(b);
  return s.slice(-2) === e.slice(-2) ? `${s.slice(0, -3)}–${e}` : `${s}–${e}`;
}

export function fmtDuration(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

const utc = (s) => new Date(`${s}T00:00:00Z`);

export function addDays(s, n) {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Whole days from a to b (positive when b is later).
export const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);

export const dowOf = (s) => DOW[utc(s).getUTCDay()];

export function startOfWeek(s, weekStartsOn = 'MO') {
  const target = DOW.indexOf(weekStartsOn);
  const cur = utc(s).getUTCDay();
  return addDays(s, -((cur - target + 7) % 7));
}

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const dfCache = new Map();
function df(opts) {
  const key = JSON.stringify(opts);
  if (!dfCache.has(key)) dfCache.set(key, new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }));
  return dfCache.get(key);
}

export const fmtDate = (s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => df(opts).format(utc(s));
export const fmtDateLong = (s) => fmtDate(s, { weekday: 'long', month: 'long', day: 'numeric' });
export const fmtDateMedium = (s) => fmtDate(s, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
export const fmtMonth = (ym) => df({ month: 'long', year: 'numeric' }).format(utc(`${ym}-01`));

// ---------------------------------------------------------------------------
// Time zones

const tzCache = new Map();

function tzParts(tz, ms) {
  let f = tzCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    tzCache.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = value;
  return p;
}

// Minutes to add to UTC to get local time in `tz` at instant `ms`.
export function tzOffsetMin(tz, ms) {
  const p = tzParts(tz, ms);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export function isValidTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Local date + minutes in `tz` -> epoch milliseconds. `min` may be negative
// or past 1440 (e.g. a leave-by time that falls on the previous evening).
export function zonedToUtc(date, min, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d) + Math.round(min * 60000);
  const off1 = tzOffsetMin(tz, guess);
  let ts = guess - off1 * 60000;
  const off2 = tzOffsetMin(tz, ts);
  if (off2 !== off1) ts = guess - off2 * 60000;
  return ts;
}

export function utcToZoned(ms, tz) {
  const off = tzOffsetMin(tz, ms);
  const l = new Date(ms + off * 60000);
  return {
    date: l.toISOString().slice(0, 10),
    min: l.getUTCHours() * 60 + l.getUTCMinutes() + l.getUTCSeconds() / 60,
  };
}

export const todayIn = (tz, nowMs = Date.now()) => utcToZoned(nowMs, tz).date;

// ---------------------------------------------------------------------------
// People

export function ageOn(dob, date) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [y, m, d] = date.split('-').map(Number);
  let years = y - by;
  let months = m - bm;
  if (d < bd) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months };
}

function birthdayIn(year, bm, bd) {
  const s = `${year}-${pad2(bm)}-${pad2(bd)}`;
  return isDate(s) ? s : `${year}-03-01`; // Feb 29 birthdays outside leap years
}

export function nextBirthday(dob, date) {
  const [by, bm, bd] = dob.split('-').map(Number);
  let year = Number(date.slice(0, 4));
  let when = birthdayIn(year, bm, bd);
  if (when < date) {
    year += 1;
    when = birthdayIn(year, bm, bd);
  }
  return { date: when, turns: year - by, inDays: diffDays(date, when) };
}

export function birthdaysBetween(dob, from, to) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
    const when = birthdayIn(y, bm, bd);
    if (when >= from && when <= to && y > by) out.push({ date: when, turns: y - by });
  }
  return out;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
