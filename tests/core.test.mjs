import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, ageOn, dowOf, fmt12, fmtRange, nextBirthday, utcToZoned, zonedToUtc } from '../js/core/time.js';
import { normalizeDb, makeIndex } from '../js/core/model.js';
import { expand, dayMarkers } from '../js/core/expand.js';
import { planTrips, haversineKm, estimateMinutes, coordKey, wantedRoutes } from '../js/core/commute.js';
import { alertsFor, upcomingAlerts } from '../js/core/alerts.js';
import { buildIcs, foldLine, escText } from '../js/core/ics.js';
import { validateDb } from '../js/core/validate.js';
import { fixtureDb } from './fixture.mjs';

const db = () => normalizeDb(fixtureDb());
const day = (d, date) => planTrips(d, expand(d, date, date));
const find = (list, id) => list.find((o) => o.sourceId === id);
const schoolRuns = (d, date) => expand(d, date, date).filter((o) => o.kind === 'school').map((o) => o.sourceId).sort();

test('time helpers', () => {
  assert.equal(zonedToUtc('2026-11-23', 7 * 60, 'America/Phoenix'), Date.UTC(2026, 10, 23, 14, 0));
  assert.deepEqual(utcToZoned(Date.UTC(2026, 10, 23, 14, 0), 'America/Phoenix'), { date: '2026-11-23', min: 420 });
  // A zone with DST still round-trips (9:30 AM on the spring-forward day).
  assert.equal(zonedToUtc('2026-03-08', 9 * 60 + 30, 'America/New_York'), Date.UTC(2026, 2, 8, 13, 30));
  assert.equal(zonedToUtc('2026-11-23', -30, 'America/Phoenix'), Date.UTC(2026, 10, 23, 6, 30));
  assert.equal(dowOf('2026-11-21'), 'SA');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(fmt12(18 * 60 + 30), '6:30 PM');
  assert.equal(fmt12(0), '12:00 AM');
  assert.equal(fmtRange(18 * 60 + 30, 19 * 60), '6:30–7:00 PM');
  assert.equal(fmtRange(11 * 60 + 30, 12 * 60 + 30), '11:30 AM–12:30 PM');
  assert.deepEqual(ageOn('2017-03-09', '2026-11-21'), { years: 9, months: 8 });
  assert.deepEqual(nextBirthday('2022-05-20', '2026-11-21'), { date: '2027-05-20', turns: 5, inDays: 180 });
});

test('school runs follow each school calendar separately', () => {
  const d = db();
  assert.deepEqual(schoolRuns(d, '2026-11-23'), ['pre-drop', 'pre-pickup', 'school-drop', 'school-pickup']);
  // Mon Nov 30: the primary school is still on Thanksgiving Break, the preschool is back.
  assert.deepEqual(schoolRuns(d, '2026-11-30'), ['pre-drop', 'pre-pickup']);
  // No primary-school runs during its winter break (the test preschool has none listed).
  assert.deepEqual(schoolRuns(d, '2026-12-22'), ['pre-drop', 'pre-pickup']);
  assert.deepEqual(schoolRuns(d, '2027-06-01'), []);
});

test('early release pickup is TBD until a dismissal time is set', () => {
  const d = db();
  let pick = find(expand(d, '2026-12-18', '2026-12-18'), 'school-pickup');
  assert.equal(pick.status, 'tbd');
  assert.equal(pick.tbdReason, 'early_release');
  assert.ok(find(expand(d, '2026-12-18', '2026-12-18'), 'school-drop').flags.includes('early_release'));
  d.calendars[0].days[1].dismissal = '12:30';
  pick = find(expand(d, '2026-12-18', '2026-12-18'), 'school-pickup');
  assert.equal(pick.status, 'scheduled');
  assert.deepEqual([pick.startMin, pick.endMin, pick.arriveMin], [750, 765, 750]);
});

test('holidays ask for confirmation; changes override per date', () => {
  const d = db();
  let music = find(expand(d, '2026-11-30', '2026-11-30'), 'music');
  assert.equal(music.status, 'check');
  assert.equal(music.holiday, 'Founders Day');
  d.exceptions.push({ schedule: 'music', date: '2026-11-30', status: 'confirmed' });
  music = find(expand(d, '2026-11-30', '2026-11-30'), 'music');
  assert.equal(music.status, 'scheduled');
  d.exceptions[0].status = 'cancelled';
  assert.equal(find(expand(d, '2026-11-30', '2026-11-30'), 'music').status, 'cancelled');
  // A makeup class makes swim an hour long.
  d.exceptions.push({ schedule: 'swim', date: '2026-11-29', variant: 'makeup' });
  const swim = find(expand(d, '2026-11-29', '2026-11-29'), 'swim');
  assert.equal(swim.endMin - swim.startMin, 60);
  assert.equal(swim.variantLabel, 'Makeup class (1 hr)');
  // Moving a single date keeps the length and the arrive-early gap.
  d.exceptions.push({ schedule: 'gym', date: '2026-12-02', start: '16:00' });
  const gym = find(expand(d, '2026-12-02', '2026-12-02'), 'gym');
  assert.deepEqual([gym.startMin, gym.endMin, gym.arriveMin], [960, 1035, 955]);
});

test('TBD recurring items start on their "from" date', () => {
  const d = db();
  assert.equal(find(expand(d, '2026-12-29', '2026-12-29'), 'hoops'), undefined);
  assert.equal(find(expand(d, '2027-01-05', '2027-01-05'), 'hoops').status, 'tbd');
  d.exceptions.push({ schedule: 'hoops', date: '2027-01-12', start: '18:00' });
  const set = find(expand(d, '2027-01-12', '2027-01-12'), 'hoops');
  assert.equal(set.status, 'scheduled');
  assert.equal(set.endMin, 19 * 60);
});

test('back-to-back runs chain from the previous stop; others start at home', () => {
  const d = db();
  const mon = day(d, '2026-11-23');
  const prePick = find(mon, 'pre-pickup');
  const schoolPick = find(mon, 'school-pickup');
  assert.equal(prePick.trip.from, 'home');
  assert.equal(schoolPick.trip.from, 'preschool');
  assert.equal(schoolPick.trip.chained, true);
  const base = estimateMinutes(haversineKm(d.places[2], d.places[1]));
  assert.equal(schoolPick.trip.baseMin, base);
  assert.equal(schoolPick.trip.factor, 1.35);
  assert.equal(schoolPick.trip.leaveMin, 15 * 60 - Math.ceil(base * 1.35) - 3);
  // Morning: preschool drop chains from the school drop 25 minutes earlier.
  assert.equal(find(mon, 'pre-drop').trip.from, 'school');
  // Wednesday gym is 70 minutes after pickup: start from home.
  assert.equal(find(day(d, '2026-12-02'), 'gym').trip.from, 'home');
  // Non-travel events never get a trip.
  assert.equal(find(day(d, '2026-11-24'), 'party').trip, null);
});

test('drive minutes prefer override, then a matching cached route', () => {
  const d = db();
  const home = d.places[0];
  const gym = d.places[4];
  d.routes.cache['home>gym'] = { min: 14, km: 9.8, from: coordKey(home), to: coordKey(gym) };
  let trip = find(day(d, '2026-12-02'), 'gym').trip;
  assert.equal(trip.src, 'route');
  assert.equal(trip.baseMin, 14);
  assert.equal(trip.leaveMin, 16 * 60 + 30 - 5 - Math.ceil(14 * 1.35) - 5);
  d.routes.overrides['home>gym'] = 25;
  trip = find(day(d, '2026-12-02'), 'gym').trip;
  assert.equal(trip.src, 'manual');
  assert.equal(trip.baseMin, 25);
  // Moving the gym invalidates the cached route.
  delete d.routes.overrides['home>gym'];
  gym.lat += 0.01;
  assert.equal(find(day(d, '2026-12-02'), 'gym').trip.src, 'estimate');
  assert.ok(wantedRoutes(d, day(d, '2026-12-02')).some(([a, b]) => a === 'home' && b === 'gym'));
  // No home coordinates: fall back to the default and say so.
  d.places[0].lat = null;
  trip = find(day(d, '2026-12-02'), 'gym').trip;
  assert.equal(trip.src, 'no_home');
  assert.equal(trip.baseMin, 20);
});

test('alerts: school runs leave-now only, activities heads-up too, TBD nags the evening before', () => {
  const d = db();
  const idx = makeIndex(d);
  const drop = alertsFor(d, find(day(d, '2026-11-23'), 'school-drop'), idx);
  assert.deepEqual(drop.map((a) => a.kind), ['leave']);
  const gym = find(day(d, '2026-12-02'), 'gym');
  const ga = alertsFor(d, gym, idx);
  assert.deepEqual(ga.map((a) => a.kind), ['heads', 'leave']);
  assert.equal(ga[0].min, gym.trip.leaveMin - 10);
  const er = alertsFor(d, find(day(d, '2026-12-18'), 'school-pickup'), idx);
  assert.equal(er.length, 1);
  assert.equal(er[0].date, '2026-12-17');
  assert.equal(er[0].min, 19 * 60);
  const up = upcomingAlerts(d, zonedToUtc('2026-12-17', 18 * 60, 'America/Phoenix'));
  assert.ok(up.some((a) => a.id === 'school-pickup@2026-12-18:eve'));
  assert.ok(up.every((a, i) => i === 0 || up[i - 1].atMs <= a.atMs));
});

test('day markers include school days off, birthdays and holidays', () => {
  const d = db();
  const m = dayMarkers(d, '2026-11-24', '2027-05-20');
  assert.ok(m.get('2026-11-30').some((x) => x.calendarId === 'school-cal' && x.type === 'no_school'));
  assert.ok(!m.get('2026-11-30').some((x) => x.calendarId === 'pre-cal'));
  assert.ok(!(m.get('2026-11-28') || []).some((x) => x.type === 'no_school'), 'weekends inside a break are not marked');
  assert.ok(m.get('2027-05-20').some((x) => x.kind === 'birthday' && x.label === 'Leo turns 5'));
  assert.ok(m.get('2026-11-30').some((x) => x.kind === 'holiday'));
});

test('ICS feed is well formed with leave-by alarms', () => {
  const d = db();
  const now = zonedToUtc('2026-11-21', 10 * 60, 'America/Phoenix');
  const ics = buildIcs(d, { nowMs: now, from: '2026-11-21', to: '2026-12-31' });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every newline is CRLF');
  const enc = new TextEncoder();
  for (const line of ics.split('\r\n')) assert.ok(enc.encode(line).length <= 75, `line too long: ${line}`);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.equal(unfolded.match(/BEGIN:VEVENT/g).length, unfolded.match(/END:VEVENT/g).length);
  // Gym on Wed Dec 2: alarms 10 min before leaving and at leave time.
  const gym = find(day(d, '2026-12-02'), 'gym');
  const block = unfolded.split('BEGIN:VEVENT').find((b) => b.includes('UID:gym@2026-12-02@family-timetable'));
  assert.ok(block, 'gym event present');
  assert.ok(block.includes('DTSTART:20261202T233000Z'));
  assert.ok(block.includes(`TRIGGER:-PT${16 * 60 + 30 - gym.trip.leaveMin}M`));
  assert.ok(block.includes(`TRIGGER:-PT${16 * 60 + 30 - gym.trip.leaveMin + 10}M`));
  // Cancelled items disappear; a TBD early release becomes an all-day nag.
  d.exceptions.push({ schedule: 'gym', date: '2026-12-02', status: 'cancelled' });
  const ics2 = buildIcs(d, { nowMs: now, from: '2026-11-21', to: '2026-12-31' }).replace(/\r\n /g, '');
  assert.ok(!ics2.includes('UID:gym@2026-12-02'));
  const er = ics2.split('BEGIN:VEVENT').find((b) => b.includes('UID:school-pickup@2026-12-18'));
  assert.ok(er.includes('DTSTART;VALUE=DATE:20261218'));
  assert.ok(er.includes('TRIGGER:-PT300M'));
  // School breaks are single multi-day events.
  assert.ok(ics2.includes('DTSTART;VALUE=DATE:20261221\r\nDTEND;VALUE=DATE:20270102'));
});

test('ICS escaping and folding', () => {
  assert.equal(escText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const long = `SUMMARY:${'🏊'.repeat(40)}`;
  const folded = foldLine(long);
  const enc = new TextEncoder();
  for (const part of folded.split('\r\n')) assert.ok(enc.encode(part).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), long);
});

test('validation', () => {
  const d = db();
  assert.deepEqual(validateDb(d).errors, []);
  d.schedules[0].place = 'nowhere';
  d.schedules[1].start = '25:00';
  d.exceptions.push({ schedule: 'gym', date: '2026-02-30' });
  d.calendars[0].days.push({ type: 'holiday', label: 'x', start: '2026-12-01' });
  const { errors } = validateDb(d);
  assert.ok(errors.some((e) => e.includes('unknown place "nowhere"')));
  assert.ok(errors.some((e) => e.includes('"25:00"')));
  assert.ok(errors.some((e) => e.includes('date must be YYYY-MM-DD')));
  assert.ok(errors.some((e) => e.includes('type must be one of')));
});
