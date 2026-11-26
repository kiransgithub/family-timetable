// Rewards accounts: an append-only ledger per child in rewards.json.
// Points are whole numbers (default 100 points = $1). Positive entries are
// rewards, negative entries are deductions (they always need a reason).
// Mistakes are voided, never deleted, so the history stays complete.

import { addMonths, daysInMonth, utcToZoned } from './time.js';

export const REWARDS_VERSION = 1;
export const OPENING = 'opening';
export const CATEGORY_TYPES = { earn: 'Rewards', deduct: 'Deductions', both: 'Either', system: 'System' };
export const MAX_POINTS = 100000000;

export const DEFAULT_CATEGORIES = [
  { id: OPENING, label: 'Opening balance', emoji: '💰', group: 'Other', type: 'system' },
  { id: 'exercise', label: 'Exercise & sports', emoji: '🏃', group: 'Activities', type: 'earn' },
  { id: 'homework', label: 'Homework', emoji: '📚', group: 'Schoolwork', type: 'earn' },
  { id: 'reading', label: 'Reading', emoji: '📖', group: 'Schoolwork', type: 'earn' },
  { id: 'tests', label: 'Tests & report cards', emoji: '🏅', group: 'Schoolwork', type: 'earn' },
  { id: 'skills', label: 'Typing & skills practice', emoji: '⌨️', group: 'Schoolwork', type: 'earn' },
  { id: 'chores', label: 'Chores & helping', emoji: '🧹', group: 'Home & chores', type: 'earn' },
  { id: 'behavior', label: 'Good behavior', emoji: '🌟', group: 'Behavior', type: 'earn' },
  { id: 'kindness', label: 'Kindness & sharing', emoji: '💛', group: 'Behavior', type: 'earn' },
  { id: 'bonus', label: 'Bonus / gift', emoji: '🎁', group: 'Other', type: 'earn' },
  { id: 'spent', label: 'Spent / bought something', emoji: '🛍️', group: 'Deductions', type: 'deduct' },
  { id: 'cashout', label: 'Cashed out', emoji: '💵', group: 'Deductions', type: 'deduct' },
  { id: 'rule', label: 'Rule broken', emoji: '⚠️', group: 'Deductions', type: 'deduct' },
  { id: 'correction', label: 'Correction', emoji: '✏️', group: 'Other', type: 'both' },
];

// A starting rewards.json for the people in the timetable db. Each weekly
// activity in the timetable becomes a reward category of its own.
export function defaultRewards(db) {
  const kids = db.members.filter((m) => m.role === 'kid').map((m) => m.id);
  const parents = db.members.filter((m) => m.role === 'parent').map((m) => ({ id: m.id, name: m.name, password: null }));
  const taken = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
  const activities = [];
  for (const s of db.schedules || []) {
    if (s.kind !== 'activity' || s.archived) continue;
    const id = `act-${s.id}`;
    if (taken.has(id)) continue;
    taken.add(id);
    activities.push({ id, label: s.title, emoji: s.emoji || '⭐', group: 'Activities', type: 'earn', schedule: s.id });
  }
  const [opening, ...rest] = DEFAULT_CATEGORIES;
  return {
    version: REWARDS_VERSION,
    pointsPerDollar: 100,
    currency: 'USD',
    unlockMinutes: 5,
    parents,
    kids,
    categories: [opening, ...activities, ...rest],
    entries: [],
    log: [],
  };
}

export function normalizeRewards(r) {
  const x = r && typeof r === 'object' ? r : {};
  x.version ??= REWARDS_VERSION;
  x.pointsPerDollar ??= 100;
  x.currency ??= 'USD';
  x.unlockMinutes ??= 5;
  for (const k of ['parents', 'kids', 'categories', 'entries', 'log']) if (!Array.isArray(x[k])) x[k] = [];
  if (!x.categories.some((c) => c.id === OPENING)) x.categories.unshift({ ...DEFAULT_CATEGORIES[0] });
  return x;
}

// ---- formatting -----------------------------------------------------------------

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US');
const MINUS = '−';

export function fmtMoney(points, ppd = 100, { sign = false } = {}) {
  const s = money.format(Math.abs(points) / ppd);
  if (points < 0) return `${MINUS}${s}`;
  return sign ? `+${s}` : s;
}

export function fmtPoints(points, { sign = false, unit = true } = {}) {
  const s = `${whole.format(Math.abs(points))}${unit ? ' pts' : ''}`;
  if (points < 0) return `${MINUS}${s}`;
  return sign ? `+${s}` : s;
}

// Compact for chart axes: 0, 500, 1,000, 12K.
export function fmtAxisPoints(points) {
  const a = Math.abs(points);
  if (a >= 10000) return `${points < 0 ? MINUS : ''}${whole.format(Math.round(a / 1000))}K`;
  return `${points < 0 ? MINUS : ''}${whole.format(a)}`;
}

// ---- ledger -------------------------------------------------------------------------

function byTime(a, b) {
  const d = Date.parse(a.at) - Date.parse(b.at);
  if (d) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function balanceOf(r, kid) {
  let total = 0;
  for (const e of r.entries) if (e.kid === kid && !e.void) total += e.points;
  return total;
}

// Entries for one child, oldest first, each with the balance after it.
export function ledger(r, kid) {
  let bal = 0;
  return r.entries.filter((e) => e.kid === kid).sort(byTime).map((e) => {
    if (!e.void) bal += e.points;
    return { ...e, balance: bal };
  });
}

export function localDate(iso, tz) {
  return utcToZoned(Date.parse(iso), tz).date;
}

export function localTime(iso, tz) {
  return utcToZoned(Date.parse(iso), tz).min;
}

// Balance if this entry were voided (used to stop a void taking the
// balance below zero).
export function balanceWithout(r, entryId) {
  const e = r.entries.find((x) => x.id === entryId);
  if (!e) return null;
  return balanceOf(r, e.kid) - (e.void ? 0 : e.points);
}

// The first entry at or after `since` (ISO time) whose running balance is
// below zero, or null. Stops a back-dated deduction from overdrawing the
// past (e.g. before the opening balance).
export function firstOverdraft(r, kid, since = null) {
  const t = since ? Date.parse(since) : -Infinity;
  for (const e of ledger(r, kid)) if (!e.void && Date.parse(e.at) >= t && e.balance < 0) return e;
  return null;
}

export function categoryMap(r) {
  return new Map(r.categories.map((c) => [c.id, c]));
}

export function periodRange(period, today) {
  const ym = today.slice(0, 7);
  if (period === 'month') return { from: `${ym}-01`, to: today };
  if (period === '3months') return { from: `${addMonths(ym, -2)}-01`, to: today };
  if (period === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  return { from: null, to: today };
}

function bump(map, key, points) {
  const cur = map.get(key) || { points: 0, count: 0 };
  cur.points += points;
  cur.count += 1;
  map.set(key, cur);
}

// Totals for one child over a date range (local dates, inclusive).
// Opening balances count toward the balance but not toward "earned".
export function summarize(r, kid, { from = null, to, tz, months = 6 } = {}) {
  const cats = categoryMap(r);
  const rows = ledger(r, kid);
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  let earned = 0;
  let deducted = 0;
  let opening = 0;
  let count = 0;
  let voided = 0;
  const earnedBy = new Map();
  const deductedBy = new Map();
  const givers = new Map();
  for (const e of rows) {
    const d = localDate(e.at, tz);
    if (!inRange(d)) continue;
    if (e.void) {
      voided += 1;
      continue;
    }
    count += 1;
    if (e.category === OPENING) {
      opening += e.points;
      continue;
    }
    // "Given by" covers rewards and deductions, not the opening balance.
    const g = givers.get(e.by) || { earned: 0, deducted: 0, count: 0 };
    g.count += 1;
    if (e.points > 0) {
      earned += e.points;
      g.earned += e.points;
      bump(earnedBy, e.category, e.points);
    } else {
      deducted -= e.points;
      g.deducted -= e.points;
      bump(deductedBy, e.category, -e.points);
    }
    givers.set(e.by, g);
  }
  const list = (map) => [...map.entries()]
    .map(([id, v]) => ({ id, label: cats.get(id)?.label || id, emoji: cats.get(id)?.emoji || '', ...v }))
    .sort((a, b) => b.points - a.points || a.label.localeCompare(b.label));

  // Month-by-month: rewards and deductions in the month, balance at month end.
  const endYm = (to || new Date().toISOString().slice(0, 10)).slice(0, 7);
  const monthly = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const ym = addMonths(endYm, -i);
    const last = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
    let mEarned = 0;
    let mDeducted = 0;
    let bal = 0;
    for (const e of rows) {
      if (e.void) continue;
      const d = localDate(e.at, tz);
      if (d <= last) bal += e.points;
      if (d.slice(0, 7) !== ym || e.category === OPENING) continue;
      if (e.points > 0) mEarned += e.points;
      else mDeducted -= e.points;
    }
    monthly.push({ ym, earned: mEarned, deducted: mDeducted, balance: bal });
  }

  return {
    balance: balanceOf(r, kid),
    earned,
    deducted,
    opening,
    net: earned - deducted,
    count,
    voided,
    earnedBy: list(earnedBy),
    deductedBy: list(deductedBy),
    givers: [...givers.entries()].map(([id, v]) => ({ id, name: r.parents.find((p) => p.id === id)?.name || id, ...v })).sort((a, b) => b.earned + b.deducted - (a.earned + a.deducted)),
    monthly,
  };
}

// ---- new entries ---------------------------------------------------------------------

export function newEntryId(kid, at) {
  const rand = globalThis.crypto?.getRandomValues ? [...globalThis.crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('') : Math.random().toString(16).slice(2, 8);
  return `${kid}-${at.replace(/[^0-9]/g, '').slice(0, 14)}-${rand}`;
}

export function makeEntry({ kid, points, category, note, at, by }) {
  return {
    id: newEntryId(kid, at),
    kid,
    points,
    category,
    note: String(note || '').trim(),
    at,
    by,
  };
}

// ---- CSV ---------------------------------------------------------------------------------

function cell(v, text = false) {
  let s = String(v ?? '');
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheet formulas from running
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(r, kid, { tz, kidName, fmtDay, fmtTime }) {
  const cats = categoryMap(r);
  const name = (id) => r.parents.find((p) => p.id === id)?.name || id;
  const header = ['Date', 'Time', 'Child', 'Type', 'Points', 'Dollars', 'Category', 'Note', 'Given by', 'Balance after (points)', 'Voided', 'Voided by', 'Void reason'];
  const rows = ledger(r, kid).map((e) => {
    const t = utcToZoned(Date.parse(e.at), tz);
    const type = e.category === OPENING ? 'Opening balance' : e.points > 0 ? 'Reward' : 'Deduction';
    return [
      fmtDay(t.date), fmtTime(t.min), cell(kidName, true), type, e.points, (e.points / r.pointsPerDollar).toFixed(2),
      cell(cats.get(e.category)?.label || e.category, true), cell(e.note, true), cell(name(e.by), true), e.balance,
      e.void ? 'yes' : '', e.void ? cell(name(e.void.by), true) : '', e.void ? cell(e.void.reason, true) : '',
    ].join(',');
  });
  return `${header.join(',')}\r\n${rows.join('\r\n')}\r\n`;
}

// ---- validation ----------------------------------------------------------------------------

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));

export function validateRewards(r, { members } = {}) {
  const errors = [];
  const warnings = [];
  if (!r || typeof r !== 'object') return { errors: ['rewards.json is not a JSON object.'], warnings };
  if (!Number.isInteger(r.pointsPerDollar) || r.pointsPerDollar <= 0) errors.push('pointsPerDollar must be a whole number above 0.');
  if (!(Number.isFinite(r.unlockMinutes) && r.unlockMinutes >= 1 && r.unlockMinutes <= 60)) errors.push('unlockMinutes must be between 1 and 60.');

  const parentIds = new Set();
  for (const p of r.parents || []) {
    if (!p?.id || parentIds.has(p.id)) errors.push(`Each parent needs a unique id (${p?.id}).`);
    parentIds.add(p?.id);
    if (!p?.name) errors.push(`Parent "${p?.id}" needs a name.`);
    const pw = p?.password;
    if (pw != null && !(pw.alg === 'PBKDF2-SHA256' && Number.isInteger(pw.iterations) && pw.iterations >= 100000 && B64.test(pw.salt || '') && B64.test(pw.hash || ''))) {
      errors.push(`Parent "${p.id}" has a damaged password record. Reset it from the app.`);
    }
  }
  if (!parentIds.size) errors.push('Add at least one parent.');

  const kids = new Set(r.kids || []);
  if (kids.size !== (r.kids || []).length) errors.push('A child is listed twice in "kids".');
  if (members) for (const k of kids) if (!members.some((m) => m.id === k)) warnings.push(`"${k}" is not in the timetable's family list.`);

  const cats = new Map();
  for (const c of r.categories || []) {
    if (!c?.id || cats.has(c.id)) errors.push(`Each category needs a unique id (${c?.id}).`);
    if (!c?.label) errors.push(`Category "${c?.id}" needs a label.`);
    if (!CATEGORY_TYPES[c?.type]) errors.push(`Category "${c?.id}" type must be one of ${Object.keys(CATEGORY_TYPES).join(', ')}.`);
    cats.set(c?.id, c);
  }

  const ids = new Set();
  for (const [i, e] of (r.entries || []).entries()) {
    const where = `Entry ${i + 1}${e?.note ? ` ("${String(e.note).slice(0, 30)}")` : ''}`;
    if (!e?.id || ids.has(e.id)) errors.push(`${where}: needs a unique id.`);
    ids.add(e?.id);
    if (!kids.has(e?.kid)) errors.push(`${where}: unknown child "${e?.kid}".`);
    if (!Number.isInteger(e?.points) || e.points === 0 || Math.abs(e.points) > MAX_POINTS) errors.push(`${where}: points must be a whole number, not 0.`);
    const c = cats.get(e?.category);
    if (!c) errors.push(`${where}: unknown category "${e?.category}".`);
    else if (c.type === 'earn' && e.points < 0) errors.push(`${where}: "${c.label}" is for rewards, not deductions.`);
    else if (c.type === 'deduct' && e.points > 0) errors.push(`${where}: "${c.label}" is for deductions, not rewards.`);
    if (e?.points < 0 && !String(e.note || '').trim()) errors.push(`${where}: a deduction needs a reason.`);
    if (!isIso(e?.at)) errors.push(`${where}: "at" must be an ISO date-time.`);
    if (!parentIds.has(e?.by)) errors.push(`${where}: "given by" must be a parent.`);
    if (e?.void != null && !(isIso(e.void.at) && parentIds.has(e.void.by) && String(e.void.reason || '').trim())) {
      errors.push(`${where}: a voided entry needs who, when and why.`);
    }
  }
  for (const k of kids) {
    const bal = balanceOf({ entries: (r.entries || []).filter((e) => Number.isInteger(e?.points)) }, k);
    if (bal < 0) warnings.push(`${k}'s balance is below zero.`);
  }
  return { errors, warnings };
}

export function hasAnyPassword(r) {
  return (r?.parents || []).some((p) => p.password);
}

