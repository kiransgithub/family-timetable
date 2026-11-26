import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDb } from '../js/core/model.js';
import { fixtureDb } from './fixture.mjs';
import {
  defaultRewards, normalizeRewards, balanceOf, ledger, summarize, balanceWithout, periodRange,
  fmtMoney, fmtPoints, fmtAxisPoints, makeEntry, toCsv, validateRewards, hasAnyPassword, OPENING,
} from '../js/core/rewards.js';
import { hashPassword, verifyPassword, passwordProblem } from '../js/core/password.js';

const TZ = 'America/Phoenix';

function setup() {
  const db = normalizeDb(fixtureDb());
  db.members.push({ id: 'sam', name: 'Sam', role: 'parent' });
  const r = normalizeRewards(defaultRewards(db));
  const add = (kid, points, category, note, at, by = 'pat') => {
    const e = makeEntry({ kid, points, category, note, at, by });
    r.entries.push(e);
    return e;
  };
  return { db, r, add };
}

test('default rewards come from the family and the timetable', () => {
  const { r } = setup();
  assert.deepEqual(r.kids, ['ava', 'leo']);
  assert.deepEqual(r.parents.map((p) => [p.id, p.password]), [['pat', null], ['sam', null]]);
  assert.equal(r.pointsPerDollar, 100);
  const ids = r.categories.map((c) => c.id);
  assert.equal(ids[0], OPENING);
  for (const id of ['act-music', 'act-gym', 'act-swim', 'act-hoops', 'chores', 'behavior', 'homework', 'spent', 'cashout', 'rule', 'correction']) assert.ok(ids.includes(id), id);
  assert.equal(r.categories.find((c) => c.id === 'act-music').label, 'Violin, choir');
  assert.equal(hasAnyPassword(r), false);
  assert.deepEqual(validateRewards(r).errors, []);
});

test('balances, running balance and voids', () => {
  const { r, add } = setup();
  add('ava', 11000, OPENING, 'Opening balance', '2026-11-25T23:18:00.000Z');
  const today = add('ava', 2000, 'chores', 'Helped in the garden', '2026-11-25T23:19:00.000Z');
  add('ava', -500, 'spent', 'Stickers', '2026-11-26T18:00:00.000Z', 'sam');
  add('leo', 11000, OPENING, 'Opening balance', '2026-11-25T23:18:00.000Z');
  assert.equal(balanceOf(r, 'ava'), 12500);
  assert.equal(balanceOf(r, 'leo'), 11000);
  assert.deepEqual(ledger(r, 'ava').map((e) => e.balance), [11000, 13000, 12500]);
  assert.equal(balanceWithout(r, today.id), 10500);
  today.void = { at: '2026-11-26T19:00:00.000Z', by: 'sam', reason: 'Entered twice' };
  assert.equal(balanceOf(r, 'ava'), 10500);
  assert.deepEqual(ledger(r, 'ava').map((e) => e.balance), [11000, 11000, 10500]);
  assert.equal(balanceWithout(r, today.id), 10500, 'voiding an already-void entry changes nothing');
});

test('summaries by category, giver and month, using local dates', () => {
  const { r, add } = setup();
  add('ava', 11000, OPENING, 'Opening balance', '2026-10-01T16:00:00.000Z');
  add('ava', 300, 'reading', 'Two books', '2026-10-15T01:00:00.000Z'); // Oct 14 local
  add('ava', 2000, 'chores', 'Thanksgiving chores', '2026-11-25T23:19:00.000Z');
  add('ava', 500, 'act-gym', 'New skill', '2026-11-27T02:00:00.000Z', 'sam'); // Nov 26 local
  add('ava', -1000, 'spent', 'Toy', '2026-12-01T06:30:00.000Z', 'sam'); // Nov 30, 11:30 PM local
  const s = summarize(r, 'ava', { ...periodRange('month', '2026-11-30'), tz: TZ, months: 3 });
  assert.deepEqual([s.earned, s.deducted, s.opening, s.net, s.count], [2500, 1000, 0, 1500, 3]);
  assert.deepEqual(s.earnedBy.map((x) => [x.id, x.points]), [['chores', 2000], ['act-gym', 500]]);
  assert.deepEqual(s.deductedBy.map((x) => [x.id, x.points]), [['spent', 1000]]);
  assert.deepEqual(s.givers.map((g) => [g.name, g.earned, g.deducted]), [['Pat', 2000, 0], ['Sam', 500, 1000]]);
  assert.deepEqual(s.monthly.map((m) => [m.ym, m.earned, m.deducted, m.balance]), [
    ['2026-09', 0, 0, 0],
    ['2026-10', 300, 0, 11300],
    ['2026-11', 2500, 1000, 12800],
  ]);
  assert.equal(s.balance, 12800);
  const all = summarize(r, 'ava', { ...periodRange('all', '2026-11-30'), tz: TZ });
  assert.deepEqual([all.earned, all.opening, all.count], [2800, 11000, 5]);
});

test('formatting points and dollars', () => {
  assert.equal(fmtMoney(13000), '$130.00');
  assert.equal(fmtMoney(2000, 100, { sign: true }), '+$20.00');
  assert.equal(fmtMoney(-1050), '−$10.50');
  assert.equal(fmtPoints(13000), '13,000 pts');
  assert.equal(fmtPoints(-500, { sign: true }), '−500 pts');
  assert.equal(fmtPoints(2000, { sign: true }), '+2,000 pts');
  assert.equal(fmtAxisPoints(12000), '12K');
  assert.equal(fmtAxisPoints(2500), '2,500');
});

test('validation catches bad entries', () => {
  const { db, r, add } = setup();
  add('ava', 100, 'reading', '', '2026-11-25T23:19:00.000Z');
  assert.deepEqual(validateRewards(r, { members: db.members }).errors, []);
  add('ava', -100, 'spent', '   ', '2026-11-25T23:20:00.000Z');
  add('ava', -100, 'reading', 'wrong type', '2026-11-25T23:21:00.000Z');
  add('zed', 100, 'reading', 'unknown kid', '2026-11-25T23:22:00.000Z');
  add('ava', 100, 'reading', 'not a parent', '2026-11-25T23:23:00.000Z', 'ava');
  add('ava', 1.5, 'reading', 'fraction', '2026-11-25T23:24:00.000Z');
  r.entries.push({ ...r.entries[0], id: 'v1', void: { at: '2026-11-25T23:30:00.000Z', by: 'pat', reason: '' } });
  r.parents[0].password = { alg: 'PBKDF2-SHA256', iterations: 1000, salt: 'abc', hash: 'def' };
  const { errors } = validateRewards(r, { members: db.members });
  const has = (s) => assert.ok(errors.some((e) => e.includes(s)), `expected an error containing "${s}"; got ${JSON.stringify(errors)}`);
  has('a deduction needs a reason');
  has('is for rewards, not deductions');
  has('unknown child "zed"');
  has('"given by" must be a parent');
  has('points must be a whole number');
  has('a voided entry needs who, when and why');
  has('damaged password record');
});

test('password hashing', async () => {
  const rec = await hashPassword('tulip-garden-42', { iterations: 2000 });
  assert.equal(rec.alg, 'PBKDF2-SHA256');
  assert.equal(rec.iterations, 2000);
  assert.ok(rec.salt.length >= 20 && rec.hash.length >= 40);
  assert.equal(await verifyPassword('tulip-garden-42', rec), true);
  assert.equal(await verifyPassword('tulip-garden-43', rec), false);
  assert.equal(await verifyPassword('', rec), false);
  assert.equal(await verifyPassword('tulip-garden-42', null), false);
  const again = await hashPassword('tulip-garden-42', { iterations: 2000 });
  assert.notEqual(again.salt, rec.salt, 'each password gets its own salt');
  assert.notEqual(again.hash, rec.hash);
  assert.ok(passwordProblem('12345'));
  assert.ok(passwordProblem('aaaaaaa'));
  assert.ok(passwordProblem('password'));
  assert.equal(passwordProblem('tulip-garden-42'), null);
});

test('CSV export escapes text and blocks spreadsheet formulas', () => {
  const { r, add } = setup();
  add('ava', 11000, OPENING, 'Opening balance', '2026-11-25T23:18:00.000Z');
  add('ava', -250, 'spent', '=HYPERLINK("x"), "quoted"', '2026-11-26T18:00:00.000Z', 'sam');
  const csv = toCsv(r, 'ava', { tz: TZ, kidName: 'Ava', fmtDay: (d) => d, fmtTime: (m) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}` });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('Date,Time,Child,Type,Points,Dollars'));
  assert.equal(lines[1], '2026-11-25,16:18,Ava,Opening balance,11000,110.00,Opening balance,Opening balance,Pat,11000,,,');
  assert.ok(lines[2].includes(`"'=HYPERLINK(""x""), ""quoted"""`), lines[2]);
  assert.ok(lines[2].includes(',-250,-2.50,'));
});

test('a back-dated deduction cannot overdraw the past', async () => {
  const { firstOverdraft } = await import('../js/core/rewards.js');
  const r = {
    entries: [
      { id: 'a', kid: 'kid1', points: 11000, category: 'opening', at: '2026-11-25T23:37:00.000Z', by: 'pat' },
      { id: 'b', kid: 'kid1', points: 2000, category: 'chores', at: '2026-11-25T23:38:00Z', by: 'pat' },
    ],
  };
  assert.equal(firstOverdraft(r, 'kid1'), null);
  const before = { entries: [...r.entries, { id: 'c', kid: 'kid1', points: -1250, at: '2026-11-24T22:10:00.000Z' }] };
  assert.equal(firstOverdraft(before, 'kid1', '2026-11-24T22:10:00.000Z').id, 'c');
  const after = { entries: [...r.entries, { id: 'c', kid: 'kid1', points: -1250, at: '2026-11-25T23:40:00.000Z' }] };
  assert.equal(firstOverdraft(after, 'kid1', '2026-11-25T23:40:00.000Z'), null);
  // Mixed ISO formats still sort by time.
  const { ledger } = await import('../js/core/rewards.js');
  assert.deepEqual(ledger(after, 'kid1').map((e) => e.id), ['a', 'b', 'c']);
});
