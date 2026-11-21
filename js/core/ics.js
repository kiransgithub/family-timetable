// iCalendar feed with "leave by" alarms (RFC 5545). Subscribe to it from
// Apple Calendar with "Remove Alarms" turned off and iOS alerts on its own,
// even when the app is closed.

import { addDays, fmt12, todayIn, zonedToUtc } from './time.js';
import { dayMarkers, expand } from './expand.js';
import { describeSource, planTrips } from './commute.js';
import { alertsFor } from './alerts.js';
import { makeIndex, namesOf, placeLabel } from './model.js';

const CRLF = '\r\n';
const encoder = new TextEncoder();

export function escText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold to 75 octets per line without splitting a UTF-8 character.
export function foldLine(line) {
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = encoder.encode(ch).length;
    if (bytes + b > limit) {
      parts.push(cur);
      cur = ch;
      bytes = b;
      limit = 74; // continuation lines start with a space
    } else {
      cur += ch;
      bytes += b;
    }
  }
  parts.push(cur);
  return parts.join(`${CRLF} `);
}

const pad = (n) => String(n).padStart(2, '0');
export function utcStamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
const ymd = (date) => date.replaceAll('-', '');
const uidPart = (s) => String(s).replace(/[^A-Za-z0-9@._-]/g, '-');

function trigger(minutesBefore) {
  const m = Math.max(0, Math.round(minutesBefore));
  return `TRIGGER:-PT${m}M`;
}

function alarmLines(text, minutesBefore) {
  return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escText(text)}`, trigger(minutesBefore), 'END:VALARM'];
}

function markerSummary(m) {
  if (m.type === 'no_school') return `🏫 ${m.short}: no school (${m.label})`;
  if (m.type === 'early_release') return `⏰ ${m.short}: early release${m.dismissal ? '' : ' (time TBD)'} · ${m.label}`;
  return `🏫 ${m.short}: ${m.label}`;
}

export function buildIcs(db, { nowMs = Date.now(), from, to } = {}) {
  const tz = db.meta.timezone;
  const feed = db.settings?.feed || {};
  const today = todayIn(tz, nowMs);
  const start = from || addDays(today, -(feed.daysBack ?? 7));
  const end = to || addDays(today, feed.daysAhead ?? 120);
  const index = makeIndex(db);
  const occs = planTrips(db, expand(db, start, end, index), index);
  const stamp = utcStamp(nowMs);
  const name = feed.calendarName || db.meta.title || 'Family Timetable';

  const L = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Timetable//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escText(name)}`,
    `X-WR-TIMEZONE:${tz}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const o of occs) {
    if (o.status === 'cancelled') continue;
    const place = index.places.get(o.placeId);
    const who = namesOf(db, o.who);
    const alerts = alertsFor(db, o, index);
    const desc = [];
    const url = feed.appUrl ? `${feed.appUrl}#/today/${o.date}` : null;

    if (o.status === 'tbd') {
      // No time yet: an all-day placeholder that nags the evening before.
      const dayStart = zonedToUtc(o.date, 0, tz);
      const why = o.tbdReason === 'early_release' ? 'Early release: the pickup time is not set yet.' : 'The time is not set yet.';
      desc.push(why, 'Open the app to add it.');
      if (o.notes) desc.push('', o.notes);
      L.push('BEGIN:VEVENT', `UID:${uidPart(o.key)}@family-timetable`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(o.date)}`, `DTEND;VALUE=DATE:${ymd(addDays(o.date, 1))}`, `SUMMARY:${escText(`⚠️ ${o.emoji ? `${o.emoji} ` : ''}${o.title}: time not set${who ? ` · ${who}` : ''}`)}`, `DESCRIPTION:${escText(desc.join('\n'))}`, 'TRANSP:TRANSPARENT');
      if (url) L.push(`URL:${url}`);
      for (const al of alerts) {
        const atMs = zonedToUtc(al.date, al.min, tz);
        L.push(...alarmLines(al.title, (dayStart - atMs) / 60000));
      }
      L.push('END:VEVENT');
      continue;
    }

    const startMs = zonedToUtc(o.date, o.startMin, tz);
    const endMs = zonedToUtc(o.date, o.endMin > o.startMin ? o.endMin : o.startMin + 15, tz);
    if (o.status === 'check') desc.push(`${o.holiday ? `${o.holiday}: ` : ''}check that this is happening.`);
    if (o.trip) {
      const fromPlace = index.places.get(o.trip.from);
      const traffic = o.trip.factor > 1.01 ? ' incl. traffic' : '';
      desc.push(`Leave by ${fmt12(o.trip.leaveMin)} from ${placeLabel(fromPlace) || 'Home'} (~${o.trip.driveMin} min drive${traffic} + ${o.trip.bufferMin} min buffer; ${describeSource(o.trip.src)}).`);
    }
    if (o.variantLabel) desc.push(o.variantLabel);
    if (o.flags.includes('early_release')) desc.push(`Early release day${o.dayLabels.length ? ` (${o.dayLabels.join(', ')})` : ''}.`);
    if (o.notes) desc.push(o.notes);
    if (o.exception?.note) desc.push(o.exception.note);

    const summary = `${o.status === 'check' ? '❓ ' : ''}${o.emoji ? `${o.emoji} ` : ''}${o.title}${who ? ` · ${who}` : ''}${o.variantLabel ? ` (${o.variantLabel})` : ''}`;
    L.push('BEGIN:VEVENT', `UID:${uidPart(o.key)}@family-timetable`, `DTSTAMP:${stamp}`, `DTSTART:${utcStamp(startMs)}`, `DTEND:${utcStamp(endMs)}`, `SUMMARY:${escText(summary)}`);
    if (place) L.push(`LOCATION:${escText([place.name, place.address].filter(Boolean).join(', '))}`);
    if (desc.length) L.push(`DESCRIPTION:${escText(desc.join('\n'))}`);
    if (url) L.push(`URL:${url}`);
    for (const al of alerts) {
      const atMs = zonedToUtc(al.date, al.min, tz);
      L.push(...alarmLines(al.title, (startMs - atMs) / 60000));
    }
    L.push('END:VEVENT');
  }

  // School calendar days (merged ranges), straight from the calendars.
  for (const cal of db.calendars) {
    for (const e of cal.days || []) {
      if (!e?.start) continue;
      const eEnd = e.end || e.start;
      if (eEnd < start || e.start > end) continue;
      const m = { short: cal.short || cal.name, type: e.type, label: e.label, dismissal: e.dismissal };
      L.push('BEGIN:VEVENT', `UID:${uidPart(`cal-${cal.id}-${e.type}-${e.start}`)}@family-timetable`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(e.start)}`, `DTEND;VALUE=DATE:${ymd(addDays(eEnd, 1))}`, `SUMMARY:${escText(markerSummary(m))}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
    }
  }

  // Birthdays and all-day one-off events.
  const markers = dayMarkers(db, start, end);
  for (const [date, list] of markers) {
    for (const m of list) {
      if (m.kind !== 'birthday' && m.kind !== 'event') continue;
      const summary = m.kind === 'birthday' ? `🎂 ${m.label}` : `${m.emoji ? `${m.emoji} ` : ''}${m.label}`;
      const uid = m.kind === 'birthday' ? `bday-${m.memberId}-${date}` : `event-${m.eventId}`;
      L.push('BEGIN:VEVENT', `UID:${uidPart(uid)}@family-timetable`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(date)}`, `DTEND;VALUE=DATE:${ymd(addDays(date, 1))}`, `SUMMARY:${escText(summary)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
    }
  }

  L.push('END:VCALENDAR');
  return L.map(foldLine).join(CRLF) + CRLF;
}

export function icsEventCount(text) {
  return (String(text).match(/BEGIN:VEVENT/g) || []).length;
}
