// Checks a db before it is saved (in the app) or published (in the GitHub
// Action), so a typo from a hand edit is caught with a readable message.

import { DOW, isDate, isHM, isValidTz } from './time.js';
import { ALARM_MODES, CAL_MODES, DAY_TYPES, HOME_ID, KINDS } from './model.js';

export function validateDb(db) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!db || typeof db !== 'object') return { errors: ['The db is not a JSON object.'], warnings };
  if (!isValidTz(db.meta?.timezone)) err(`meta.timezone "${db.meta?.timezone}" is not a valid time zone.`);

  const ids = (list, label) => {
    const seen = new Set();
    for (const [i, x] of (list || []).entries()) {
      if (!x || typeof x !== 'object') {
        err(`${label}[${i}] is not an object.`);
        continue;
      }
      if (!x.id || typeof x.id !== 'string') err(`${label}[${i}] needs an "id".`);
      else if (seen.has(x.id)) err(`${label}: id "${x.id}" is used twice.`);
      else seen.add(x.id);
    }
    return seen;
  };

  const memberIds = ids(db.members, 'members');
  const placeIds = ids(db.places, 'places');
  const calendarIds = ids(db.calendars, 'calendars');
  const scheduleIds = ids(db.schedules, 'schedules');
  ids(db.events, 'events');

  for (const m of db.members || []) {
    if (!m?.name) err(`Member "${m?.id}" needs a name.`);
    if (m?.dob && !isDate(m.dob)) err(`Member "${m.id}": dob "${m.dob}" must be YYYY-MM-DD.`);
    if (m?.school?.place && !placeIds.has(m.school.place)) err(`Member "${m.id}": school place "${m.school.place}" does not exist.`);
    if (m?.school?.calendar && !calendarIds.has(m.school.calendar)) err(`Member "${m.id}": school calendar "${m.school.calendar}" does not exist.`);
  }

  for (const p of db.places || []) {
    if (!p?.name) err(`Place "${p?.id}" needs a name.`);
    for (const k of ['lat', 'lng']) if (p?.[k] != null && !Number.isFinite(p[k])) err(`Place "${p.id}": ${k} must be a number or null.`);
    if (p?.bufferMin != null && !Number.isFinite(p.bufferMin)) err(`Place "${p.id}": bufferMin must be a number.`);
    if (p && p.id !== HOME_ID && !p.address) warn(`Place "${p.name}" has no address.`);
  }
  const home = (db.places || []).find((p) => p.id === HOME_ID);
  if (!home) err('There must be a place with id "home".');
  else if (!home.address && !Number.isFinite(home.lat)) warn('Home has no address yet, so drive times start from a guess.');

  for (const c of db.calendars || []) {
    if (!c?.name) err(`Calendar "${c?.id}" needs a name.`);
    for (const k of ['firstDay', 'lastDay']) if (c?.[k] && !isDate(c[k])) err(`Calendar "${c.id}": ${k} must be YYYY-MM-DD.`);
    for (const [i, d] of (c?.days || []).entries()) {
      const where = `Calendar "${c.id}" day ${i + 1}${d?.label ? ` (${d.label})` : ''}`;
      if (!d || !DAY_TYPES[d.type]) err(`${where}: type must be one of ${Object.keys(DAY_TYPES).join(', ')}.`);
      if (!isDate(d?.start)) err(`${where}: start must be YYYY-MM-DD.`);
      if (d?.end && (!isDate(d.end) || d.end < d.start)) err(`${where}: end must be a date on or after start.`);
      if (d?.dismissal && !isHM(d.dismissal)) err(`${where}: dismissal must be HH:MM (24-hour).`);
    }
    if (c?.verify) warn(`Calendar "${c.name}" is marked "verify": confirm its dates.`);
  }

  const timeFields = (x, where) => {
    for (const k of ['start', 'end', 'arrive']) if (x[k] != null && x[k] !== '' && !isHM(x[k])) err(`${where}: ${k} "${x[k]}" must be HH:MM (24-hour).`);
    if (x.durationMin != null && !(Number.isFinite(x.durationMin) && x.durationMin > 0)) err(`${where}: durationMin must be a positive number.`);
    if (isHM(x.start) && isHM(x.end) && x.end < x.start) err(`${where}: end is before start.`);
    if (x.alarms && !ALARM_MODES[x.alarms]) err(`${where}: alarms must be one of ${Object.keys(ALARM_MODES).join(', ')}.`);
    for (const w of x.who || []) if (!memberIds.has(w)) err(`${where}: unknown person "${w}".`);
    if (x.place && !placeIds.has(x.place)) err(`${where}: unknown place "${x.place}".`);
    if (x.origin && x.origin !== 'auto' && !placeIds.has(x.origin)) err(`${where}: origin "${x.origin}" is not a place.`);
  };

  for (const s of db.schedules || []) {
    const where = `Recurring "${s?.title || s?.id}"`;
    if (!s?.title) err(`${where}: needs a title.`);
    if (!Array.isArray(s?.days) || !s.days.length) err(`${where}: pick at least one day.`);
    else for (const d of s.days) if (!DOW.includes(d)) err(`${where}: day "${d}" must be one of ${DOW.join(', ')}.`);
    if (s?.kind && !KINDS[s.kind]) err(`${where}: kind must be one of ${Object.keys(KINDS).join(', ')}.`);
    for (const k of ['from', 'until']) if (s?.[k] && !isDate(s[k])) err(`${where}: ${k} must be YYYY-MM-DD.`);
    if (s?.calendar && !calendarIds.has(s.calendar)) err(`${where}: unknown calendar "${s.calendar}".`);
    if (s?.calendarMode && !CAL_MODES[s.calendarMode]) err(`${where}: calendarMode must be one of ${Object.keys(CAL_MODES).join(', ')}.`);
    if (s && !s.start && !s.tbd) warn(`${where} has no start time.`);
    const vids = new Set();
    for (const v of s?.variants || []) {
      if (!v?.id || vids.has(v.id)) err(`${where}: each variant needs a unique id.`);
      vids.add(v?.id);
      if (v?.durationMin != null && !Number.isFinite(v.durationMin)) err(`${where}: variant "${v.id}" durationMin must be a number.`);
    }
    if (s) timeFields(s, where);
  }

  for (const e of db.events || []) {
    const where = `Event "${e?.title || e?.id}"`;
    if (!e?.title) err(`${where}: needs a title.`);
    if (!isDate(e?.date)) err(`${where}: date must be YYYY-MM-DD.`);
    if (e) timeFields(e, where);
  }

  const exKeys = new Set();
  for (const [i, x] of (db.exceptions || []).entries()) {
    const where = `Change ${i + 1}${x?.schedule ? ` (${x.schedule} on ${x.date})` : ''}`;
    if (!x?.schedule || !scheduleIds.has(x.schedule)) err(`${where}: unknown recurring item "${x?.schedule}".`);
    if (!isDate(x?.date)) err(`${where}: date must be YYYY-MM-DD.`);
    const key = `${x?.schedule}@${x?.date}`;
    if (exKeys.has(key)) err(`${where}: there are two changes for the same date.`);
    exKeys.add(key);
    if (x?.status && !['cancelled', 'confirmed', 'check'].includes(x.status)) err(`${where}: status must be cancelled, confirmed or check.`);
    if (x) timeFields(x, where);
  }

  for (const [i, hday] of (db.holidays || []).entries()) {
    if (!isDate(hday?.date)) err(`Holiday ${i + 1}: date must be YYYY-MM-DD.`);
    if (!hday?.name) err(`Holiday ${i + 1}: needs a name.`);
  }

  for (const [k, v] of Object.entries(db.routes?.overrides || {})) {
    if (!Number.isFinite(v) || v < 0) err(`Drive-time override "${k}" must be a number of minutes.`);
  }

  return { errors, warnings };
}
