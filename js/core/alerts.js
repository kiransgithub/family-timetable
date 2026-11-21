// Alert times for planned occurrences. The in-app scheduler and the
// calendar feed both use this, so a popup and an iPhone alarm always agree.

import { addDays, fmt12, hmToMin, isHM, todayIn, zonedToUtc } from './time.js';
import { expand } from './expand.js';
import { planTrips } from './commute.js';
import { makeIndex, namesOf, placeLabel } from './model.js';

function detail(db, o, index) {
  const place = index.places.get(o.placeId);
  const parts = [];
  const who = namesOf(db, o.who);
  if (who) parts.push(who);
  if (o.startMin != null) parts.push(`${fmt12(o.startMin)}${place ? ` at ${placeLabel(place)}` : ''}`);
  if (o.trip) {
    const from = index.places.get(o.trip.from);
    parts.push(`~${o.trip.driveMin} min drive from ${from ? placeLabel(from) : 'home'}`);
  }
  return parts.join(' · ');
}

export function alertsFor(db, o, index = makeIndex(db)) {
  const a = db.settings?.alerts || {};
  const heads = Number(a.headsUpMin ?? 10);
  const evening = isHM(a.eveningReminder) ? hmToMin(a.eveningReminder) : 19 * 60;
  const mode = o.alarms || 'both';
  const out = [];
  if (o.allDay || o.status === 'cancelled' || mode === 'none') return out;
  const body = detail(db, o, index);
  const label = `${o.emoji ? `${o.emoji} ` : ''}${o.title}`;

  if (o.status === 'tbd' || o.status === 'check') {
    let title;
    if (o.tbdReason === 'early_release') title = `Tomorrow is early release: set the ${o.title} time`;
    else if (o.status === 'tbd') title = `Tomorrow: ${o.title} has no time set`;
    else title = `Tomorrow${o.holiday ? ` (${o.holiday})` : ''}: is ${o.title} on?`;
    out.push({ id: `${o.key}:eve`, key: o.key, date: addDays(o.date, -1), min: evening, kind: 'reminder', title, body });
    if (o.status === 'tbd') return out;
  }

  if (o.trip) {
    if (mode === 'both' && heads > 0) {
      out.push({ id: `${o.key}:heads`, key: o.key, date: o.date, min: o.trip.leaveMin - heads, kind: 'heads', title: `Leave in ${heads} min · ${label}`, body });
    }
    out.push({ id: `${o.key}:leave`, key: o.key, date: o.date, min: o.trip.leaveMin, kind: 'leave', title: `Leave now · ${label}`, body });
  } else if (o.startMin != null && heads > 0) {
    out.push({ id: `${o.key}:start`, key: o.key, date: o.date, min: o.startMin - heads, kind: 'start', title: `In ${heads} min · ${label}`, body });
  }
  return out;
}

// Alerts due between (now - lookBackMin) and the end of tomorrow.
export function upcomingAlerts(db, nowMs = Date.now(), lookBackMin = 15) {
  const tz = db.meta.timezone;
  const today = todayIn(tz, nowMs);
  const index = makeIndex(db);
  // Include the day after tomorrow so tomorrow-evening reminders are known.
  const occs = planTrips(db, expand(db, today, addDays(today, 2), index), index);
  const list = [];
  for (const o of occs) {
    for (const al of alertsFor(db, o, index)) {
      const atMs = zonedToUtc(al.date, al.min, tz);
      if (atMs >= nowMs - lookBackMin * 60000) list.push({ ...al, atMs, occurrence: o });
    }
  }
  list.sort((x, y) => x.atMs - y.atMs);
  return list;
}
