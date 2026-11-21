// Turns the recurring schedules, one-off events, school calendars and
// per-date changes in the db into concrete occurrences for a date range.

import { addDays, birthdaysBetween, dowOf, hmToMin, isHM } from './time.js';
import { makeIndex } from './model.js';

export function calendarDay(cal, date) {
  const info = { inSession: true, noSchool: false, earlyRelease: false, dismissal: null, entries: [], first: false, last: false };
  if (!cal) return info;
  info.inSession = (!cal.firstDay || date >= cal.firstDay) && (!cal.lastDay || date <= cal.lastDay);
  info.first = date === cal.firstDay;
  info.last = date === cal.lastDay;
  for (const e of cal.days || []) {
    if (!e || !e.start) continue;
    const end = e.end || e.start;
    if (date < e.start || date > end) continue;
    info.entries.push(e);
    if (e.type === 'no_school') info.noSchool = true;
    else if (e.type === 'early_release') {
      info.earlyRelease = true;
      if (isHM(e.dismissal)) info.dismissal = e.dismissal;
    }
  }
  return info;
}

function timesOf(item) {
  const startMin = isHM(item.start) ? hmToMin(item.start) : null;
  let endMin = startMin;
  if (startMin != null) {
    if (isHM(item.end)) endMin = hmToMin(item.end);
    else if (Number.isFinite(item.durationMin)) endMin = startMin + item.durationMin;
  }
  let arriveMin = null;
  if (isHM(item.arrive)) arriveMin = hmToMin(item.arrive);
  else if (startMin != null) arriveMin = startMin - (Number(item.arriveEarlyMin) || 0);
  return { startMin, endMin, arriveMin };
}

function baseOccurrence(item, date, type) {
  const { startMin, endMin, arriveMin } = timesOf(item);
  const tbd = startMin == null || item.tbd === true;
  return {
    key: type === 'schedule' ? `${item.id}@${date}` : `event:${item.id}`,
    type,
    sourceId: item.id,
    date,
    title: item.title || 'Untitled',
    emoji: item.emoji || '',
    kind: item.kind || (type === 'event' ? 'other' : 'activity'),
    who: Array.isArray(item.who) ? item.who : [],
    placeId: item.place || null,
    startMin,
    endMin,
    arriveMin,
    status: tbd ? 'tbd' : 'scheduled',
    tbdReason: tbd ? 'time' : null,
    flags: [],
    dayLabels: [],
    notes: item.notes || '',
    alarms: item.alarms || 'both',
    travel: item.travel !== false,
    origin: item.origin || 'auto',
    variants: Array.isArray(item.variants) ? item.variants : [],
    variant: null,
    variantLabel: null,
    exception: null,
    changed: false,
    confirmed: false,
    holiday: null,
    allDay: false,
  };
}

function moveStart(o, newStart) {
  const len = o.startMin != null && o.endMin != null ? o.endMin - o.startMin : 0;
  const arriveOffset = o.startMin != null && o.arriveMin != null ? o.startMin - o.arriveMin : 0;
  o.startMin = newStart;
  o.endMin = newStart + len;
  o.arriveMin = newStart - arriveOffset;
}

function applyCalendar(o, s, cal) {
  if (!cal) return true;
  const info = calendarDay(cal, o.date);
  if (s.calendarMode === 'school_days') {
    if (!info.inSession || info.noSchool) return false;
    if (info.earlyRelease) {
      o.flags.push('early_release');
      o.dayLabels = info.entries.map((e) => e.label);
      if (s.earlyRelease === 'pickup') {
        if (info.dismissal) {
          moveStart(o, hmToMin(info.dismissal));
          o.arriveMin = o.startMin;
          o.changed = true;
        } else {
          o.status = 'tbd';
          o.tbdReason = 'early_release';
        }
      }
    }
  } else if (info.noSchool) {
    o.flags.push('no_school');
    o.dayLabels = info.entries.map((e) => e.label);
  }
  return true;
}

function applyException(o, ex, s) {
  if (!ex) return;
  o.exception = ex;
  if (isHM(ex.start)) {
    if (o.startMin == null) {
      o.startMin = hmToMin(ex.start);
      o.endMin = o.startMin + (Number.isFinite(s?.durationMin) ? s.durationMin : 30);
      o.arriveMin = o.startMin - (Number(s?.arriveEarlyMin) || 0);
    } else {
      moveStart(o, hmToMin(ex.start));
    }
    if (o.status === 'tbd') {
      o.status = 'scheduled';
      o.tbdReason = null;
    }
    o.changed = true;
  }
  if (ex.variant) {
    const v = o.variants.find((x) => x.id === ex.variant);
    if (v) {
      o.variant = v.id;
      o.variantLabel = v.label;
      if (Number.isFinite(v.durationMin) && o.startMin != null) o.endMin = o.startMin + v.durationMin;
    }
  }
  if (isHM(ex.end)) {
    o.endMin = hmToMin(ex.end);
    o.changed = true;
  } else if (Number.isFinite(ex.durationMin) && o.startMin != null) {
    o.endMin = o.startMin + ex.durationMin;
    o.changed = true;
  }
  if (isHM(ex.arrive)) o.arriveMin = hmToMin(ex.arrive);
  if (ex.place !== undefined) {
    o.placeId = ex.place || null;
    o.changed = true;
  }
  if (ex.origin) o.origin = ex.origin;
  if (ex.status === 'cancelled') o.status = 'cancelled';
  else if (ex.status === 'check') o.status = 'check';
  else if (ex.status === 'confirmed') o.confirmed = true;
}

function byDateTime(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ta = a.startMin ?? a.arriveMin ?? 9999;
  const tb = b.startMin ?? b.arriveMin ?? 9999;
  if (ta !== tb) return ta - tb;
  return a.title.localeCompare(b.title);
}

// All timed occurrences between two dates (inclusive), sorted.
export function expand(db, from, to, index = makeIndex(db)) {
  const out = [];
  for (const s of db.schedules) {
    if (!s || s.archived || !Array.isArray(s.days) || !s.days.length) continue;
    const days = new Set(s.days);
    const start = s.from && s.from > from ? s.from : from;
    const end = s.until && s.until < to ? s.until : to;
    const cal = s.calendar ? index.calendars.get(s.calendar) : null;
    for (let date = start; date <= end; date = addDays(date, 1)) {
      if (!days.has(dowOf(date))) continue;
      const o = baseOccurrence(s, date, 'schedule');
      if (!applyCalendar(o, s, cal)) continue;
      applyException(o, index.exceptions.get(o.key), s);
      const hol = index.holidays.get(date);
      if (hol && o.status !== 'cancelled') {
        o.holiday = hol.name;
        o.flags.push('holiday');
        if (o.status === 'scheduled' && !o.confirmed) o.status = 'check';
      }
      out.push(o);
    }
  }
  for (const e of db.events) {
    if (!e || e.allDay || !e.date || e.date < from || e.date > to) continue;
    const o = baseOccurrence(e, e.date, 'event');
    if (e.cancelled) o.status = 'cancelled';
    out.push(o);
  }
  out.sort(byDateTime);
  return out;
}

export const expandDay = (db, date, index) => expand(db, date, date, index);

// All-day markers per date: school days off, early release, first/last
// day, birthdays, holidays and all-day events.
export function dayMarkers(db, from, to) {
  const map = new Map();
  const push = (d, m) => {
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(m);
  };
  for (const cal of db.calendars) {
    const base = { kind: 'calendar', calendarId: cal.id, short: cal.short || cal.name, color: cal.color, verify: !!cal.verify };
    for (const e of cal.days || []) {
      if (!e || !e.start) continue;
      const end = e.end || e.start;
      const a = e.start > from ? e.start : from;
      const b = end < to ? end : to;
      const range = end !== e.start;
      for (let d = a; d <= b; d = addDays(d, 1)) {
        if (range && (dowOf(d) === 'SA' || dowOf(d) === 'SU')) continue; // weekends inside a break
        push(d, { ...base, type: e.type, label: e.label, dismissal: e.dismissal || null });
      }
    }
    if (cal.firstDay && cal.firstDay >= from && cal.firstDay <= to) push(cal.firstDay, { ...base, type: 'first_day', label: 'First day of school' });
    if (cal.lastDay && cal.lastDay >= from && cal.lastDay <= to) push(cal.lastDay, { ...base, type: 'last_day', label: 'Last day of school' });
  }
  for (const m of db.members) {
    if (!m.dob) continue;
    for (const b of birthdaysBetween(m.dob, from, to)) push(b.date, { kind: 'birthday', memberId: m.id, label: `${m.name} turns ${b.turns}`, color: m.color });
  }
  for (const h of db.holidays) if (h.date >= from && h.date <= to) push(h.date, { kind: 'holiday', label: h.name });
  for (const e of db.events) {
    if (e.allDay && e.date >= from && e.date <= to) push(e.date, { kind: 'event', label: e.title, emoji: e.emoji || '', who: e.who || [], eventId: e.id });
  }
  return map;
}

export function forMember(list, memberId) {
  if (!memberId || memberId === 'all') return list;
  return list.filter((o) => !o.who.length || o.who.includes(memberId));
}
