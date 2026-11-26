// Rewards tab: each child's balance, analytics and full history. Anyone can
// look; adding, deducting, voiding, categories and passwords need a parent
// password (see services/lock.js). All values from rewards.json are set as
// text, never HTML.

import { h, icon, openModal, field, input, select, chips, formError, toast, download } from './dom.js';
import { fmt12, fmtDate, fmtDateMedium, isDate, isHM, hmToMin, minToHM, utcToZoned, zonedToUtc } from '../core/time.js';
import {
  balanceOf, balanceWithout, categoryMap, defaultRewards, firstOverdraft, fmtMoney, fmtPoints,
  hasAnyPassword, ledger, makeEntry, periodRange, summarize, toCsv, CATEGORY_TYPES,
} from '../core/rewards.js';
import { hashPassword, passwordProblem, verifyPassword, MIN_LENGTH } from '../core/password.js';
import { kidsOf, uniqueId } from '../core/model.js';
import { ValidationError } from '../store.js';
import * as lock from '../services/lock.js';
import { balanceLine, hideTip, monthColumns, monthTable, rankedBars } from './charts.js';

const ui = { period: 'month', show: 'all', table: false, historyLimit: 40 };
const PERIODS = [['month', 'This month'], ['3months', '3 months'], ['year', 'This year'], ['all', 'All time']];

const errText = (e) => (e instanceof ValidationError ? e.errors[0] : e?.message || String(e));
const tzOf = (ctx) => ctx.db.meta.timezone;
const nowIso = (ctx) => new Date(ctx.now()).toISOString();
const parentName = (r, id) => r.parents.find((p) => p.id === id)?.name || id;
const kidName = (ctx, id) => ctx.db.members.find((m) => m.id === id)?.name || id;
const kidColor = (ctx, id) => ctx.db.members.find((m) => m.id === id)?.color || '#64748b';

function when(ctx, iso) {
  const t = utcToZoned(Date.parse(iso), tzOf(ctx));
  return { date: t.date, min: t.min, day: fmtDate(t.date, { weekday: 'short', month: 'short', day: 'numeric' }), time: fmt12(Math.floor(t.min)) };
}

// Compact dollars for chart axes: $0, $12.50, $250, $1.5K.
function fmtAxisMoney(points, ppd) {
  const d = points / ppd;
  if (d >= 1000) return `$${(d / 1000).toFixed(d % 1000 ? 1 : 0)}K`;
  return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
}

function fmtMonthShort(ym, long = false) {
  return fmtDate(`${ym}-01`, long ? { month: 'long', year: 'numeric' } : { month: 'short' });
}

function primaryButton() {
  const modals = document.querySelectorAll('#modal-root .modal');
  return modals[modals.length - 1]?.querySelector('.modal-actions .btn-primary');
}

function submitOnEnter(...inputs) {
  for (const el of inputs) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); primaryButton()?.click(); } });
}

// ---- unlocking ------------------------------------------------------------------------------------

// Resolves to the unlocked parent's id, or null if cancelled.
export function requireParent(ctx, purpose = 'make changes') {
  const rs = ctx.rewards;
  const r = rs.data;
  const current = lock.currentParent();
  if (current && r.parents.some((p) => p.id === current)) return Promise.resolve(current);
  if (!ctx.store.canWrite) {
    toast('This device is view-only, so rewards can only be changed from a parent\'s device.', { kind: 'warn', ms: 6000 });
    return Promise.resolve(null);
  }
  if (!r.parents.length) {
    toast('Add the parents under Manage → Family first.', { kind: 'warn' });
    return Promise.resolve(null);
  }
  if (!hasAnyPassword(r)) return setFirstPassword(ctx);
  return new Promise((resolve) => {
    let done = false;
    const withPw = r.parents.filter((p) => p.password);
    const missing = r.parents.filter((p) => !p.password);
    const who = chips(withPw.map((p) => ({ value: p.id, label: p.name })), [withPw[0].id], { multi: false });
    const pw = input({ type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password' });
    const err = h('div', { class: 'form-error', hidden: true });
    submitOnEnter(pw);
    openModal({
      title: 'Parents only',
      body: h('div', { class: 'form' },
        h('p', null, `Enter your password to ${purpose}.`),
        withPw.length > 1 ? field('Who are you?', who.el) : h('p', { class: 'muted small' }, `Signing in as ${withPw[0].name}.`),
        field('Password', pw),
        missing.length ? h('p', { class: 'muted small' }, `${missing.map((p) => p.name).join(' and ')} ${missing.length > 1 ? 'have' : 'has'} no password yet. ${withPw[0].name} can set one under Passwords.`) : null,
        err),
      onClose: () => { if (!done) resolve(null); },
      actions: [
        { label: 'Cancel', ghost: true },
        {
          label: 'Unlock',
          primary: true,
          onClick: async () => {
            const wait = lock.waitSeconds();
            if (wait) {
              formError(err, [`Too many wrong tries. Try again in ${wait} seconds.`]);
              return true;
            }
            const id = withPw.length > 1 ? who.get()[0] : withPw[0].id;
            const p = r.parents.find((x) => x.id === id);
            if (!pw.value || !(await verifyPassword(pw.value, p.password))) {
              lock.recordFailure();
              pw.value = '';
              formError(err, ['That password is not right.']);
              pw.focus();
              return true;
            }
            lock.unlock(id, r.unlockMinutes);
            done = true;
            resolve(id);
            return false;
          },
        },
      ],
    });
  });
}

// The unlock can run out (or the app can go to the background) while a form
// is open: check again at save time and ask for the password if needed.
async function stillUnlocked(ctx) {
  return lock.currentParent() || requireParent(ctx, 'save this');
}

function newPasswordFields() {
  const a = input({ type: 'password', autocomplete: 'new-password', placeholder: `At least ${MIN_LENGTH} characters` });
  const b = input({ type: 'password', autocomplete: 'new-password', placeholder: 'Type it again' });
  return {
    els: [field('New password', a), field('Confirm', b)],
    inputs: [a, b],
    problem: () => passwordProblem(a.value) || (a.value !== b.value ? 'The two passwords don\'t match.' : null),
    value: () => a.value,
  };
}

async function savePassword(ctx, targetId, by, password, action) {
  const rec = await hashPassword(password);
  const at = nowIso(ctx);
  await ctx.rewards.mutate((d) => {
    const p = d.parents.find((x) => x.id === targetId);
    if (!p) throw new Error('That parent is no longer in rewards.json.');
    if (action === 'password_set' && !by && d.parents.some((x) => x.password)) throw new Error('A password was just set on another device. Use Unlock instead.');
    p.password = { ...rec, setAt: at, setBy: by || targetId };
    d.log.push({ at, by: by || targetId, action, target: targetId });
  }, `${action === 'password_set' ? 'Set' : action === 'password_changed' ? 'Change' : 'Reset'} rewards password for ${parentName(ctx.rewards.data, targetId)}`);
}

// No passwords yet: the first parent sets theirs here. Any later password
// can only be set by a parent who is already unlocked.
function setFirstPassword(ctx) {
  const r = ctx.rewards.data;
  return new Promise((resolve) => {
    let done = false;
    const who = chips(r.parents.map((p) => ({ value: p.id, label: p.name })), [r.parents[0].id], { multi: false });
    const f = newPasswordFields();
    const err = h('div', { class: 'form-error', hidden: true });
    submitOnEnter(...f.inputs);
    openModal({
      title: 'Set up parent passwords',
      body: h('div', { class: 'form' },
        h('p', null, `Only ${r.parents.map((p) => p.name).join(' and ')} can add or remove rewards. Pick who you are and choose a password. The other parent's password can be set right after, from Passwords.`),
        field('Who are you?', who.el),
        ...f.els,
        h('p', { class: 'muted small' }, 'The password itself is never saved, only a scrambled check value, in your private data repo.'),
        err),
      onClose: () => { if (!done) resolve(null); },
      actions: [
        { label: 'Cancel', ghost: true },
        {
          label: 'Save password',
          primary: true,
          onClick: async () => {
            const problem = f.problem();
            if (problem) {
              formError(err, [problem]);
              return true;
            }
            const id = who.get()[0];
            try {
              await savePassword(ctx, id, null, f.value(), 'password_set');
            } catch (e) {
              formError(err, [errText(e)]);
              return true;
            }
            lock.unlock(id, r.unlockMinutes);
            done = true;
            toast(`Password saved. Unlocked as ${parentName(r, id)}.`, { kind: 'ok' });
            resolve(id);
            return false;
          },
        },
      ],
    });
  });
}

function passwordForm(ctx, targetId, by, action) {
  const r = ctx.rewards.data;
  const f = newPasswordFields();
  const err = h('div', { class: 'form-error', hidden: true });
  submitOnEnter(...f.inputs);
  const target = parentName(r, targetId);
  const mine = targetId === by;
  openModal({
    title: mine ? 'Change my password' : `${r.parents.find((p) => p.id === targetId)?.password ? 'Reset' : 'Set'} ${target}'s password`,
    body: h('div', { class: 'form' },
      mine ? null : h('p', null, `Type a new password for ${target}, then tell ${target} what it is. ${target} can change it after unlocking.`),
      ...f.els,
      err),
    actions: [
      { label: 'Cancel', ghost: true },
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          const problem = f.problem();
          if (problem) {
            formError(err, [problem]);
            return true;
          }
          const who = await stillUnlocked(ctx);
          if (who !== by) {
            if (who) formError(err, [`Unlocked as ${parentName(r, who)} now. Open Passwords again.`]);
            return true;
          }
          try {
            await savePassword(ctx, targetId, by, f.value(), action);
          } catch (e) {
            formError(err, [errText(e)]);
            return true;
          }
          lock.extend(r.unlockMinutes);
          toast(mine ? 'Password changed' : `${target}'s password saved`, { kind: 'ok' });
          return false;
        },
      },
    ],
  });
}

export function openSecurity(ctx) {
  const r = ctx.rewards.data;
  const me = lock.currentParent();
  const describe = (l) => {
    const who = parentName(r, l.by);
    const target = parentName(r, l.target);
    const what = { password_set: 'set', password_changed: 'changed', password_reset: 'reset' }[l.action] || l.action;
    return `${who} ${what} ${l.by === l.target ? 'their own' : `${target}'s`} password`;
  };
  const close = openModal({
    title: 'Passwords',
    body: h('div', { class: 'form' },
      h('ul', { class: 'pw-list' }, r.parents.map((p) => h('li', null,
        h('span', null, h('strong', null, p.name), h('span', { class: 'muted small' }, p.password ? ` · set ${p.password.setAt ? fmtDateMedium(when(ctx, p.password.setAt).date) : ''}` : ' · no password yet')),
        me ? h('button', {
          class: 'btn btn-small',
          onclick: () => { close(); passwordForm(ctx, p.id, me, p.id === me ? 'password_changed' : p.password ? 'password_reset' : 'password_set'); },
        }, p.id === me ? 'Change mine' : p.password ? 'Reset' : 'Set') : null))),
      me
        ? h('p', { class: 'muted small' }, `Unlocked as ${parentName(r, me)}. Forgot a password? The other parent can reset it here.`)
        : h('p', { class: 'muted small' }, 'Unlock first to change or reset a password.'),
      r.log.length ? h('details', { class: 'past' }, h('summary', null, 'Password history'), h('ul', { class: 'log-list' }, r.log.slice(-10).reverse().map((l) => {
        const w = when(ctx, l.at);
        return h('li', null, `${w.day}, ${w.time}: ${describe(l)}`);
      }))) : null),
    actions: me
      ? [{ label: 'Lock now', ghost: true, onClick: () => { lock.lock(); toast('Locked'); } }, { label: 'Done', primary: true }]
      : [{ label: 'Close', ghost: true }, { label: 'Unlock', primary: true, onClick: async () => { const id = await requireParent(ctx, 'manage passwords'); if (id) openSecurity(ctx); } }],
  });
}

// ---- add / deduct / void ----------------------------------------------------------------------------

function categoryOptions(r, kind) {
  const okTypes = kind === 'earn' ? ['earn', 'both'] : ['deduct', 'both'];
  const groups = new Map();
  for (const c of r.categories) {
    if (c.hidden || !okTypes.includes(c.type)) continue;
    const g = c.group || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const sel = h('select', { 'aria-label': 'Category' });
  for (const [g, list] of groups) {
    const og = h('optgroup', { label: g });
    for (const c of list) og.append(h('option', { value: c.id }, `${c.emoji ? `${c.emoji} ` : ''}${c.label}`));
    sel.append(og);
  }
  return sel;
}

// Would adding `points` at `atMs` overdraw the balance at that time or later?
function overdraft(r, kid, points, atMs) {
  const at = new Date(atMs).toISOString();
  return firstOverdraft({ ...r, entries: [...r.entries, { id: '~new', kid, points, at }] }, kid, at);
}

export async function addEntry(ctx, kid, kind) {
  const by = await requireParent(ctx, kind === 'earn' ? 'add a reward' : 'deduct from a balance');
  if (by) entryForm(ctx, kid, kind, by);
}

function entryForm(ctx, kid, kind, by) {
  const r = ctx.rewards.data;
  const ppd = r.pointsPerDollar;
  const tz = tzOf(ctx);
  const name = kidName(ctx, kid);
  const balance = balanceOf(r, kid);
  let unit = '$';
  const amount = input({ type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '0.00', class: 'amount-input', 'aria-label': 'Amount' });
  const conv = h('small', { class: 'field-hint' }, ' ');
  const unitBtns = ['$', 'pts'].map((u) => h('button', { type: 'button', class: `seg ${u === unit ? 'seg-on' : ''}`, 'aria-pressed': u === unit ? 'true' : 'false', onclick: () => setUnit(u) }, u === '$' ? 'Dollars' : 'Points'));
  const toPoints = () => {
    const v = Number.parseFloat(amount.value);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.round(unit === '$' ? v * ppd : v);
  };
  const update = () => {
    const p = toPoints();
    conv.textContent = p ? (unit === '$' ? `= ${fmtPoints(p)}` : `= ${fmtMoney(p, ppd)}`) : ' ';
  };
  function setUnit(u) {
    const p = toPoints();
    unit = u;
    unitBtns.forEach((b, i) => { const on = ['$', 'pts'][i] === u; b.classList.toggle('seg-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    amount.step = u === '$' ? '0.01' : '1';
    amount.placeholder = u === '$' ? '0.00' : '0';
    if (p) amount.value = u === '$' ? (p / ppd).toFixed(2) : String(p);
    update();
  }
  amount.addEventListener('input', update);
  const quick = h('div', { class: 'chip-row' }, [1, 2, 5, 10, 20].map((d) => h('button', { type: 'button', class: 'chip', onclick: () => { setUnit('$'); amount.value = d.toFixed(2); update(); } }, `$${d}`)));
  const cat = categoryOptions(r, kind);
  const note = input({ placeholder: kind === 'earn' ? 'What was it for? (optional)' : 'Why? e.g. bought a book at the fair', maxlength: '200' });
  const now = utcToZoned(ctx.now(), tz);
  const date = input({ type: 'date', value: now.date, max: now.date });
  const time = input({ type: 'time', value: minToHM(Math.floor(now.min)) });
  const err = h('div', { class: 'form-error', hidden: true });
  submitOnEnter(amount, note);
  const verb = kind === 'earn' ? 'Add reward' : 'Deduct';
  openModal({
    title: `${verb}: ${name}`,
    body: h('div', { class: 'form' },
      h('div', { class: 'amount-row' }, field('Amount', amount, null), h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Unit' }, unitBtns)),
      conv,
      quick,
      field(kind === 'earn' ? 'For' : 'Type of deduction', cat),
      field(kind === 'earn' ? 'Note' : 'Reason (required)', note),
      h('div', { class: 'row2' }, field('Date', date), field('Time', time)),
      h('p', { class: 'muted small' }, `Given by ${parentName(r, by)} · ${name}'s balance now ${fmtMoney(balance, ppd)} (${fmtPoints(balance)})`),
      err),
    actions: [
      { label: 'Cancel', ghost: true },
      {
        label: verb,
        primary: true,
        onClick: async () => {
          const points = toPoints();
          const problems = [];
          if (!points) problems.push('Enter an amount above zero.');
          if (kind === 'deduct' && !note.value.trim()) problems.push('Add a reason for the deduction.');
          if (!isDate(date.value) || !isHM(time.value)) problems.push('Pick a date and time.');
          const atMs = problems.length ? 0 : zonedToUtc(date.value, hmToMin(time.value), tz);
          if (atMs > ctx.now() + 5 * 60000) problems.push('That date and time is in the future.');
          if (kind === 'deduct' && points > balance) problems.push(`${name} only has ${fmtMoney(balance, ppd)} (${fmtPoints(balance)}).`);
          else if (kind === 'deduct' && !problems.length) {
            const od = overdraft(r, kid, -points, atMs);
            if (od) problems.push(`That would take ${name} below $0 on ${when(ctx, od.at).day} (${fmtMoney(od.balance, ppd)} then). Pick a later date or a smaller amount.`);
          }
          if (problems.length) {
            formError(err, problems);
            return true;
          }
          const who = await stillUnlocked(ctx);
          if (!who) return true;
          const signed = kind === 'earn' ? points : -points;
          const entry = makeEntry({ kid, points: signed, category: cat.value, note: note.value, at: new Date(atMs).toISOString(), by: who });
          try {
            await ctx.rewards.mutate((d) => {
              if (signed < 0 && balanceOf(d, kid) + signed < 0) throw new Error(`${name} only has ${fmtMoney(balanceOf(d, kid), ppd)} now.`);
              d.entries.push(entry);
              const od = signed < 0 ? firstOverdraft(d, kid, entry.at) : null;
              if (od) throw new Error(`That would take ${name} below $0 on ${when(ctx, od.at).day}. Pick a later date or a smaller amount.`);
            }, `${kind === 'earn' ? 'Reward' : 'Deduct'} ${fmtPoints(signed, { sign: true })} for ${name} by ${parentName(r, who)}`);
          } catch (e) {
            formError(err, [errText(e)]);
            return true;
          }
          lock.extend(r.unlockMinutes);
          toast(`${fmtMoney(signed, ppd, { sign: true })} ${kind === 'earn' ? 'added for' : 'deducted from'} ${name}`, { kind: 'ok' });
          return false;
        },
      },
    ],
  });
  setTimeout(() => amount.focus(), 60);
}

export async function voidEntry(ctx, entryId) {
  const by = await requireParent(ctx, 'void an entry');
  if (!by) return;
  const r = ctx.rewards.data;
  const e = r.entries.find((x) => x.id === entryId);
  if (!e || e.void) return;
  const ppd = r.pointsPerDollar;
  const name = kidName(ctx, e.kid);
  const cat = categoryMap(r).get(e.category);
  const w = when(ctx, e.at);
  const reason = input({ placeholder: 'e.g. Entered twice', maxlength: '200' });
  const err = h('div', { class: 'form-error', hidden: true });
  submitOnEnter(reason);
  openModal({
    title: 'Void this entry?',
    body: h('div', { class: 'form' },
      h('p', null, `${fmtMoney(e.points, ppd, { sign: true })} (${fmtPoints(e.points, { sign: true })}) for ${name} · ${cat?.label || e.category}${e.note ? `: ${e.note}` : ''} · ${w.day}, ${w.time} by ${parentName(r, e.by)}`),
      h('p', { class: 'muted small' }, 'It stays in the history, crossed out, and stops counting toward the balance.'),
      field('Why? (required)', reason),
      err),
    actions: [
      { label: 'Keep it', ghost: true },
      {
        label: 'Void entry',
        primary: true,
        onClick: async () => {
          if (!reason.value.trim()) {
            formError(err, ['Say why it is being voided.']);
            return true;
          }
          if (balanceWithout(r, e.id) < 0) {
            formError(err, [`Voiding this would take ${name}'s balance below $0.`]);
            return true;
          }
          const who = await stillUnlocked(ctx);
          if (!who) return true;
          try {
            await ctx.rewards.mutate((d) => {
              const x = d.entries.find((y) => y.id === e.id);
              if (!x || x.void) return false;
              if (balanceWithout(d, x.id) < 0) throw new Error(`Voiding this would take ${name}'s balance below $0.`);
              x.void = { at: nowIso(ctx), by: who, reason: reason.value.trim() };
              return undefined;
            }, `Void ${fmtPoints(e.points, { sign: true })} for ${name} by ${parentName(r, who)}`);
          } catch (ex) {
            formError(err, [errText(ex)]);
            return true;
          }
          lock.extend(r.unlockMinutes);
          toast('Entry voided', { kind: 'ok' });
          return false;
        },
      },
    ],
  });
}

// ---- categories --------------------------------------------------------------------------------------

function categoryForm(ctx, id, by) {
  const r = ctx.rewards.data;
  const existing = id ? r.categories.find((c) => c.id === id) : null;
  const label = input({ value: existing?.label || '', placeholder: 'e.g. Practiced violin' });
  const emoji = input({ value: existing?.emoji || '', maxlength: '8', class: 'emoji-input', placeholder: '⭐' });
  const groups = [...new Set(r.categories.map((c) => c.group || 'Other'))];
  const group = input({ value: existing?.group || 'Activities', list: 'reward-groups' });
  const groupList = h('datalist', { id: 'reward-groups' }, groups.map((g) => h('option', { value: g })));
  const type = select(Object.entries(CATEGORY_TYPES).filter(([k]) => k !== 'system').map(([value, l]) => ({ value, label: l })), existing?.type || 'earn');
  const hidden = h('input', { type: 'checkbox', checked: !!existing?.hidden });
  const err = h('div', { class: 'form-error', hidden: true });
  openModal({
    title: existing ? `Edit: ${existing.label}` : 'New category',
    body: h('div', { class: 'form' },
      h('div', { class: 'row-title' }, field('Name', label), field('Emoji', emoji)),
      h('div', { class: 'row2' }, field('Group', group), field('Used for', type)),
      groupList,
      existing ? h('label', { class: 'check' }, hidden, h('span', null, 'Hide from the picker (past entries keep it)')) : null,
      err),
    actions: [
      { label: 'Cancel', ghost: true },
      {
        label: existing ? 'Save' : 'Add',
        primary: true,
        onClick: async () => {
          if (!label.value.trim()) {
            formError(err, ['Give it a name.']);
            return true;
          }
          const who = await stillUnlocked(ctx);
          if (!who) return true;
          try {
            await ctx.rewards.mutate((d) => {
              if (existing) {
                const c = d.categories.find((x) => x.id === existing.id);
                Object.assign(c, { label: label.value.trim(), emoji: emoji.value.trim() || undefined, group: group.value.trim() || 'Other', type: type.value });
                if (hidden.checked) c.hidden = true;
                else delete c.hidden;
                if (!c.emoji) delete c.emoji;
              } else {
                d.categories.push({ id: uniqueId(label.value, d.categories.map((c) => c.id)), label: label.value.trim(), emoji: emoji.value.trim() || '⭐', group: group.value.trim() || 'Other', type: type.value });
              }
            }, `${existing ? 'Edit' : 'Add'} reward category ${label.value.trim()} by ${parentName(r, who)}`);
          } catch (e) {
            formError(err, [errText(e)]);
            return true;
          }
          lock.extend(r.unlockMinutes);
          toast('Saved', { kind: 'ok' });
          return false;
        },
      },
    ],
  });
}

export function openCategories(ctx) {
  const r = ctx.rewards.data;
  const me = lock.currentParent();
  const groups = new Map();
  for (const c of r.categories) {
    if (c.type === 'system') continue;
    const g = c.group || 'Other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const close = openModal({
    title: 'Reward categories',
    wide: true,
    body: h('div', { class: 'form' },
      [...groups].map(([g, list]) => h('section', null,
        h('h3', null, g),
        h('ul', { class: 'cat-list' }, list.map((c) => h('li', { class: c.hidden ? 'cat-hidden' : '' },
          h('span', null, `${c.emoji ? `${c.emoji} ` : ''}${c.label}`, h('span', { class: 'muted small' }, ` · ${CATEGORY_TYPES[c.type]}${c.hidden ? ' · hidden' : ''}`)),
          me ? h('button', { class: 'btn btn-small', onclick: () => { close(); categoryForm(ctx, c.id, me); } }, 'Edit') : null))))),
      me ? null : h('p', { class: 'muted small' }, 'Unlock to add or edit categories.')),
    actions: me
      ? [{ label: 'Close', ghost: true }, { label: 'Add category', primary: true, onClick: () => { categoryForm(ctx, null, me); } }]
      : [{ label: 'Close', ghost: true }, { label: 'Unlock', primary: true, onClick: async () => { const id = await requireParent(ctx, 'edit categories'); if (id) openCategories(ctx); } }],
  });
}

// ---- views -------------------------------------------------------------------------------------------

function lockChip(ctx) {
  const r = ctx.rewards.data;
  const me = lock.currentParent();
  if (!me) {
    return h('button', { class: 'lock-chip', onclick: () => requireParent(ctx, 'make changes'), title: 'Parents: unlock to make changes' }, icon('lock'), h('span', null, 'Locked'));
  }
  const label = h('span', null);
  const tickText = () => {
    const s = lock.secondsLeft();
    label.textContent = `${parentName(r, me)} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tickText();
  const chip = h('button', { class: 'lock-chip lock-chip-open', onclick: () => { lock.lock(); toast('Locked'); }, title: 'Lock now' }, icon('unlock'), label, h('span', { class: 'lock-chip-action' }, 'Lock'));
  const timer = setInterval(() => {
    if (!chip.isConnected || !lock.currentParent()) {
      clearInterval(timer);
      return;
    }
    tickText();
  }, 1000);
  return chip;
}

function setupNeeded(ctx) {
  const rs = ctx.rewards;
  if (rs.status === 'loading' || rs.status === 'idle') return h('div', { class: 'empty' }, h('p', null, 'Loading rewards…'));
  if (rs.status === 'missing') {
    return h('div', { class: 'welcome-card' },
      h('h2', null, 'Rewards are not set up yet'),
      h('p', null, 'This creates rewards.json next to your timetable data, with an account for each child. Balances start at $0.'),
      h('div', { class: 'section-actions' }, h('button', {
        class: 'btn btn-primary',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await rs.create(defaultRewards(ctx.db));
            toast('Rewards set up', { kind: 'ok' });
          } catch (err) {
            toast(`Not set up: ${errText(err)}`, { kind: 'error', ms: 7000 });
          }
        },
      }, 'Set up rewards')));
  }
  return h('div', { class: 'banner banner-error' }, icon('alert'), h('span', null, `Rewards could not load: ${rs.error || 'unknown problem'}`), h('button', { class: 'btn btn-small', onclick: () => rs.refresh() }, 'Try again'));
}

function kidSwitcher(ctx, r, current) {
  const kids = kidsOf(ctx.db).filter((k) => r.kids.includes(k.id));
  return h('div', { class: 'filters filters-inline', role: 'tablist', 'aria-label': 'Child' },
    h('a', { class: `fchip ${!current ? 'fchip-on' : ''}`, href: '#/rewards', role: 'tab', 'aria-selected': !current ? 'true' : 'false' }, 'Both'),
    kids.map((k) => h('a', { class: `fchip ${current === k.id ? 'fchip-on' : ''}`, href: `#/rewards/${k.id}`, role: 'tab', 'aria-selected': current === k.id ? 'true' : 'false' }, h('span', { class: 'dot', style: { background: k.color || '#64748b' } }), k.name)));
}

function overview(ctx, r) {
  const tz = tzOf(ctx);
  const today = ctx.today();
  const ppd = r.pointsPerDollar;
  const kids = kidsOf(ctx.db).filter((k) => r.kids.includes(k.id));
  return h('div', { class: 'reward-cards' }, kids.map((k) => {
    const s = summarize(r, k.id, { ...periodRange('month', today), tz, months: 1 });
    const last = ledger(r, k.id).filter((e) => !e.void).at(-1);
    const cat = last ? categoryMap(r).get(last.category) : null;
    return h('a', { class: 'reward-card', href: `#/rewards/${k.id}`, style: { '--kid': k.color || '#64748b' } },
      h('div', { class: 'reward-card-head' }, h('div', { class: 'avatar avatar-sm' }, k.name.slice(0, 1)), h('strong', null, k.name)),
      h('div', { class: 'reward-card-balance' }, fmtMoney(s.balance, ppd)),
      h('div', { class: 'muted small' }, fmtPoints(s.balance)),
      h('div', { class: 'reward-card-month' }, `This month: ${fmtMoney(s.earned, ppd, { sign: true })} earned · ${fmtMoney(-s.deducted, ppd)} deducted`),
      last ? h('div', { class: 'muted small' }, `Last: ${when(ctx, last.at).day} · ${cat?.emoji || ''} ${last.note || cat?.label || ''} ${fmtMoney(last.points, ppd, { sign: true })}`) : null);
  }));
}

function kpi(label, value, sub) {
  return h('div', { class: 'kpi' }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null);
}

function card(title, ...body) {
  return h('section', { class: 'rcard' }, title ? h('h3', { class: 'rcard-title' }, title) : null, ...body);
}

function history(ctx, r, kid) {
  const ppd = r.pointsPerDollar;
  const cats = categoryMap(r);
  let rows = ledger(r, kid).reverse();
  if (ui.show === 'earned') rows = rows.filter((e) => e.points > 0);
  if (ui.show === 'deducted') rows = rows.filter((e) => e.points < 0);
  const shown = rows.slice(0, ui.historyLimit);
  const filter = h('div', { class: 'seg-group seg-small', role: 'group', 'aria-label': 'Show' },
    [['all', 'All'], ['earned', 'Rewards'], ['deducted', 'Deductions']].map(([v, l]) => h('button', {
      type: 'button',
      class: `seg ${ui.show === v ? 'seg-on' : ''}`,
      'aria-pressed': ui.show === v ? 'true' : 'false',
      onclick: () => { ui.show = v; ui.historyLimit = 40; ctx.rerender(); },
    }, l)));
  return card(null,
    h('div', { class: 'rcard-head' }, h('h3', { class: 'rcard-title' }, 'History'), filter),
    shown.length ? h('ul', { class: 'ledger' }, shown.map((e) => {
      const c = cats.get(e.category);
      const w = when(ctx, e.at);
      return h('li', { class: `lentry ${e.void ? 'lentry-void' : ''} ${e.points < 0 ? 'lentry-minus' : 'lentry-plus'}` },
        h('div', { class: 'lentry-when' }, h('div', null, w.day), h('div', { class: 'muted' }, w.time)),
        h('div', { class: 'lentry-main' },
          h('div', { class: 'lentry-what' }, `${c?.emoji ? `${c.emoji} ` : ''}${c?.label || e.category}`),
          e.note ? h('div', { class: 'lentry-note' }, e.note) : null,
          h('div', { class: 'muted small' }, `${e.points < 0 ? 'Deducted' : 'Given'} by ${parentName(r, e.by)}`),
          e.void ? h('div', { class: 'lentry-voided' }, `Voided by ${parentName(r, e.void.by)} on ${when(ctx, e.void.at).day}: ${e.void.reason}`) : null),
        h('div', { class: 'lentry-amount' },
          h('div', { class: 'lentry-money' }, fmtMoney(e.points, ppd, { sign: true })),
          h('div', { class: 'muted small' }, fmtPoints(e.points, { sign: true })),
          h('div', { class: 'muted small' }, e.void ? 'not counted' : `bal. ${fmtMoney(e.balance, ppd)}`)),
        e.void ? h('span') : h('button', { class: 'icon-btn', 'aria-label': 'Void this entry', title: 'Void (parents)', onclick: () => voidEntry(ctx, e.id) }, icon('more')));
    })) : h('p', { class: 'muted small' }, 'Nothing here yet.'),
    rows.length > shown.length ? h('div', { class: 'agenda-foot' }, h('button', { class: 'btn btn-small btn-ghost', onclick: () => { ui.historyLimit += 100; ctx.rerender(); } }, `Show more (${rows.length - shown.length})`)) : null);
}

// Months shown in the trend charts: from the first entry's month (so a new
// account doesn't show empty months before it existed), at most 6.
function trendMonths(r, kid, tz, today) {
  const first = ledger(r, kid).find((e) => !e.void);
  if (!first) return 1;
  const a = when({ db: { meta: { timezone: tz } } }, first.at).date.slice(0, 7);
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = today.slice(0, 7).split('-').map(Number);
  return Math.max(1, Math.min(6, (yb - ya) * 12 + (mb - ma) + 1));
}

// Charts are drawn at the size they appear, so their text stays readable.
function chartWidth() {
  const w = Math.min(window.innerWidth || 600, 1180) - 32 - 30;
  return Math.max(280, Math.min(1100, w));
}

function account(ctx, r, kid) {
  const tz = tzOf(ctx);
  const today = ctx.today();
  const ppd = r.pointsPerDollar;
  const name = kidName(ctx, kid);
  const range = periodRange(ui.period, today);
  const nMonths = trendMonths(r, kid, tz, today);
  const s = summarize(r, kid, { ...range, tz, months: nMonths });
  const money = (p) => fmtMoney(p, ppd);
  const periodLabel = PERIODS.find(([v]) => v === ui.period)[1];
  const periodRow = h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Period' }, PERIODS.map(([v, l]) => h('button', {
    type: 'button',
    class: `seg ${ui.period === v ? 'seg-on' : ''}`,
    'aria-pressed': ui.period === v ? 'true' : 'false',
    onclick: () => { ui.period = v; ctx.rerender(); },
  }, l)));
  const fmtVal = (it) => `${money(it.points)}`;
  const fmtTipText = (it) => `${it.label} · ${fmtPoints(it.points)} · ${it.count} time${it.count === 1 ? '' : 's'}`;
  const monthOpts = { fmtAxis: (v) => fmtAxisMoney(v, ppd), fmtValue: (v) => `${money(v)} (${fmtPoints(v)})`, fmtMonth: fmtMonthShort, width: Math.min(chartWidth(), 120 + nMonths * 160) };
  const trendTitle = nMonths === 1 ? fmtMonthShort(s.monthly[0].ym, true) : `Last ${nMonths} months`;
  return h('div', { class: 'account', style: { '--kid': kidColor(ctx, kid) } },
    h('section', { class: 'hero' },
      h('div', { class: 'hero-top' }, h('div', { class: 'hero-label' }, `${name}'s balance`), lockChip(ctx)),
      h('div', { class: 'hero-value' }, money(s.balance)),
      h('div', { class: 'hero-sub' }, `${fmtPoints(s.balance)} · ${ppd} points = $1`),
      h('div', { class: 'hero-actions' },
        h('button', { class: 'btn btn-primary', onclick: () => addEntry(ctx, kid, 'earn') }, icon('plus'), 'Add reward'),
        h('button', { class: 'btn', onclick: () => addEntry(ctx, kid, 'deduct') }, icon('minus'), 'Deduct'))),
    h('div', { class: 'filter-row' }, periodRow),
    h('div', { class: 'kpis' },
      kpi('Rewards', fmtMoney(s.earned, ppd, { sign: true }), `${fmtPoints(s.earned)} · ${periodLabel.toLowerCase()}`),
      kpi('Deductions', fmtMoney(-s.deducted, ppd), `${fmtPoints(s.deducted)}`),
      kpi('Net', fmtMoney(s.net, ppd, { sign: true }), s.opening ? `Opening balance ${money(s.opening)} not counted` : `${s.count} entr${s.count === 1 ? 'y' : 'ies'}`)),
    h('div', { class: 'rgrid' },
      card('Rewards by activity', rankedBars(s.earnedBy, { series: 1, fmtValue: fmtVal, fmtTip: fmtTipText, empty: `No rewards ${ui.period === 'all' ? 'yet' : 'in this period'}.` })),
      card('Deductions by reason', rankedBars(s.deductedBy, { series: 2, fmtValue: fmtVal, fmtTip: fmtTipText, empty: `No deductions ${ui.period === 'all' ? 'yet' : 'in this period'}.` }))),
    card(null,
      h('div', { class: 'rcard-head' }, h('h3', { class: 'rcard-title' }, trendTitle), h('button', { class: 'btn btn-small btn-ghost', 'aria-pressed': ui.table ? 'true' : 'false', onclick: () => { ui.table = !ui.table; ctx.rerender(); } }, ui.table ? 'Show charts' : 'Show table')),
      ui.table
        ? monthTable(s.monthly, monthOpts)
        : [
          monthColumns(s.monthly, monthOpts),
          h('h4', { class: 'viz-subtitle' }, 'Balance at month end'),
          s.monthly.length > 1
            ? balanceLine(s.monthly, { ...monthOpts, fmtValue: money })
            : h('p', { class: 'muted small' }, `${money(s.monthly[0].balance)} at the end of ${fmtMonthShort(s.monthly[0].ym, true)} so far. The balance line fills in from next month.`),
        ]),
    s.givers.length ? card('Given by', h('ul', { class: 'givers' }, s.givers.map((g) => h('li', null,
      h('strong', null, g.name),
      h('span', null, `${fmtMoney(g.earned, ppd, { sign: true })} rewards`),
      h('span', null, `${fmtMoney(-g.deducted, ppd)} deductions`),
      h('span', { class: 'muted' }, `${g.count} entr${g.count === 1 ? 'y' : 'ies'}`))))) : null,
    history(ctx, r, kid),
    h('div', { class: 'section-actions' },
      h('button', {
        class: 'btn btn-small',
        onclick: () => {
          const csv = toCsv(r, kid, { tz, kidName: name, fmtDay: (d) => d, fmtTime: (m) => fmt12(Math.floor(m)) });
          download(`rewards-${kid}-${today}.csv`, csv, 'text/csv');
        },
      }, icon('download'), 'Export CSV'),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => openCategories(ctx) }, 'Categories'),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => openSecurity(ctx) }, icon('lock'), 'Passwords')));
}

export function renderRewards(ctx, kidParam) {
  hideTip();
  const rs = ctx.rewards;
  const r = rs.data;
  const wrap = h('div', { class: 'view view-rewards' }, h('div', { class: 'datenav' }, h('div', { class: 'datenav-title' }, h('h1', null, 'Rewards'), h('span', null, r ? `${r.pointsPerDollar} points = $1` : ''))));
  if (!r) {
    wrap.append(setupNeeded(ctx));
    return wrap;
  }
  const kid = kidParam && r.kids.includes(kidParam) ? kidParam : null;
  wrap.append(kidSwitcher(ctx, r, kid));
  if (rs.status === 'offline' || rs.status === 'error') {
    wrap.append(h('div', { class: `banner ${rs.status === 'error' ? 'banner-error' : ''}` }, icon('alert'),
      h('span', null, rs.status === 'offline' ? 'Offline: showing the last balances this device saw. Changes need a connection.' : `Rewards sync problem: ${rs.error || 'unknown'}`),
      h('button', { class: 'btn btn-small', onclick: () => rs.refresh() }, 'Try again')));
  }
  const unset = r.parents.filter((p) => !p.password);
  if (!hasAnyPassword(r)) {
    wrap.append(h('div', { class: 'banner' }, icon('lock'), h('span', null, 'Set your parent passwords now, before the kids use a device that can make changes.'), h('button', {
      class: 'btn btn-small',
      onclick: async () => {
        const id = await requireParent(ctx, 'set up passwords');
        if (id) openSecurity(ctx); // straight on to the other parent's password
      },
    }, 'Set up')));
  } else if (unset.length) {
    wrap.append(h('div', { class: 'banner' }, icon('lock'), h('span', null, `${unset.map((p) => p.name).join(' and ')} ${unset.length > 1 ? 'have' : 'has'} no password yet.`), h('button', { class: 'btn btn-small', onclick: () => openSecurity(ctx) }, 'Passwords')));
  }
  wrap.append(kid ? account(ctx, r, kid) : overview(ctx, r));
  if (!kid) {
    wrap.append(h('div', { class: 'section-actions' },
      lockChip(ctx),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => openCategories(ctx) }, 'Categories'),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => openSecurity(ctx) }, icon('lock'), 'Passwords')));
  }
  return wrap;
}

export function kidBalanceLink(ctx, kidId) {
  const r = ctx.rewards?.data;
  if (!r || !r.kids.includes(kidId)) return null;
  const bal = balanceOf(r, kidId);
  return h('a', { class: 'kid-rewards', href: `#/rewards/${kidId}` }, icon('rewards'), h('span', null, `Rewards: ${fmtMoney(bal, r.pointsPerDollar)} (${fmtPoints(bal)})`));
}

