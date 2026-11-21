// Editing: the per-date options menu, editors for every part of the db,
// the Manage screens, and first-run setup.

import { h, icon, openModal, field, input, select, textarea, checkbox, chips, formError, toast, confirmDialog, copyText, download, clear } from './dom.js';
import { addDays, DOW, DOW_SHORT, fmt12, fmtDate, fmtDateMedium, hmToMin, isHM, minToHM, todayIn } from '../core/time.js';
import { ALARM_MODES, CAL_MODES, DAY_TYPES, HOME_ID, KINDS, emptyDb, normalizeDb, placeLabel, uniqueId } from '../core/model.js';
import { coordKey, describeSource, hasCoords, planTrips, routeKey, wantedRoutes, baseDrive } from '../core/commute.js';
import { expand, expandDay } from '../core/expand.js';
import { validateDb } from '../core/validate.js';
import { makeIndex } from '../core/model.js';
import { geocode, parseLatLng, roadRoute } from '../services/geo.js';
import { notificationsSupported, requestNotifications } from '../services/notify.js';
import { Store, ValidationError } from '../store.js';
import { fmtDays } from './views.js';

const DAY_OPTIONS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].map((d) => ({ value: d, label: DOW_SHORT[d] }));

function errText(e) {
  if (e instanceof ValidationError) return e.errors[0];
  return e?.message || String(e);
}

export async function save(ctx, fn, message, okText) {
  try {
    const changed = await ctx.store.mutate(fn, message);
    if (okText && changed !== false) toast(okText, { kind: 'ok' });
    return true;
  } catch (e) {
    toast(`Not saved: ${errText(e)}`, { kind: 'error', ms: 7000 });
    return false;
  }
}

// Try a change on a copy first so the form can show every problem at once.
function precheck(ctx, fn) {
  const draft = normalizeDb(structuredClone(ctx.db));
  fn(draft);
  return validateDb(draft).errors;
}

const valOrNull = (v) => (v === '' || v == null ? null : v);
const numOrNull = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

function cleanObject(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === '') delete o[k];
  return o;
}

// ---- per-date changes ----------------------------------------------------------

export function upsertException(d, schedule, date, patch) {
  let ex = d.exceptions.find((x) => x.schedule === schedule && x.date === date);
  if (!ex) {
    ex = { schedule, date };
    d.exceptions.push(ex);
  }
  Object.assign(ex, patch);
  for (const k of Object.keys(ex)) if (ex[k] === undefined) delete ex[k];
  ex.schedule = schedule;
  ex.date = date;
  if (Object.keys(ex).length === 2) d.exceptions = d.exceptions.filter((x) => x !== ex);
  d.exceptions.sort((a, b) => a.date.localeCompare(b.date) || a.schedule.localeCompare(b.schedule));
}

function baseOf(ctx, o) {
  const d = structuredClone(ctx.db);
  d.exceptions = d.exceptions.filter((x) => !(x.schedule === o.sourceId && x.date === o.date));
  return expandDay(normalizeDb(d), o.date).find((x) => x.key === o.key) || o;
}

export function openOccMenu(ctx, o) {
  const db = ctx.db;
  const s = o.type === 'schedule' ? db.schedules.find((x) => x.id === o.sourceId) : null;
  const ev = o.type === 'event' ? db.events.find((x) => x.id === o.sourceId) : null;
  const items = [];
  const when = fmtDate(o.date, { weekday: 'short', month: 'short', day: 'numeric' });
  const setEx = (patch, okText) => save(ctx, (d) => upsertException(d, o.sourceId, o.date, patch), `${o.title} on ${o.date}`, okText);

  if (s) {
    for (const v of o.variants) {
      const on = o.variant === v.id;
      items.push({ label: on ? `Undo: ${v.label}` : v.label, icon: on ? 'x' : 'plus', run: () => setEx({ variant: on ? undefined : v.id }, on ? 'Back to the normal length' : `${v.label}: saved`) });
    }
    if (o.status === 'check') items.push({ label: `It's on${o.holiday ? ` (${o.holiday})` : ''}`, icon: 'check', run: () => setEx({ status: 'confirmed' }, 'Marked as on') });
    if (o.tbdReason === 'early_release' || (o.flags.includes('early_release') && s.earlyRelease === 'pickup')) {
      items.push({ label: 'Set the early-release pickup time…', icon: 'edit', run: () => editEarlyRelease(ctx, o) });
    }
    if (o.status !== 'cancelled') items.push({ label: `Cancel ${when} only`, icon: 'x', danger: true, run: () => setEx({ status: 'cancelled' }, 'Cancelled for that date') });
    else items.push({ label: `Restore ${when}`, icon: 'refresh', run: () => setEx({ status: undefined }, 'Restored') });
    items.push({ label: o.status === 'tbd' && o.tbdReason === 'time' ? `Set the time for ${when}…` : `Change time or place for ${when}…`, icon: 'edit', run: () => editOccurrence(ctx, o) });
    if (o.exception) {
      items.push({ label: `Undo all changes for ${when}`, icon: 'refresh', run: () => save(ctx, (d) => { d.exceptions = d.exceptions.filter((x) => !(x.schedule === o.sourceId && x.date === o.date)); }, `Undo changes to ${o.title}`, 'Changes undone') });
    }
    items.push({ label: 'Edit the recurring item…', icon: 'calendar', run: () => editSchedule(ctx, s.id) });
  }
  if (ev) {
    items.push({ label: 'Edit…', icon: 'edit', run: () => editEvent(ctx, ev.id) });
    items.push(ev.cancelled
      ? { label: 'Restore', icon: 'refresh', run: () => save(ctx, (d) => { delete d.events.find((x) => x.id === ev.id).cancelled; }, `Restore ${ev.title}`, 'Restored') }
      : { label: 'Cancel (keep it listed)', icon: 'x', run: () => save(ctx, (d) => { d.events.find((x) => x.id === ev.id).cancelled = true; }, `Cancel ${ev.title}`, 'Cancelled') });
    items.push({ label: 'Delete', icon: 'trash', danger: true, run: async () => { if (await confirmDialog('Delete this event?', `"${ev.title}" on ${when} will be removed.`, { confirmLabel: 'Delete', danger: true })) save(ctx, (d) => { d.events = d.events.filter((x) => x.id !== ev.id); }, `Delete ${ev.title}`, 'Deleted'); } });
  }
  const place = db.places.find((p) => p.id === o.placeId);
  const close = openModal({
    title: `${o.emoji ? `${o.emoji} ` : ''}${o.title}`,
    body: h('div', { class: 'menu' },
      h('p', { class: 'menu-sub' }, `${when} · ${o.startMin == null ? 'time TBD' : fmt12(o.startMin)}${place ? ` · ${place.name}` : ''}`),
      o.trip ? h('p', { class: 'menu-sub' }, `Leave by ${fmt12(o.trip.leaveMin)}: ~${o.trip.driveMin} min from ${placeLabel(db.places.find((p) => p.id === o.trip.from)) || 'Home'} (${describeSource(o.trip.src)})`) : null,
      o.notes ? h('p', { class: 'menu-note' }, o.notes) : null,
      items.map((it) => h('button', { class: `menu-item ${it.danger ? 'menu-danger' : ''}`, onclick: () => { close(); it.run(); } }, icon(it.icon || 'edit'), h('span', null, it.label)))),
  });
}

function placeOptions(db, { none = 'No drive needed' } = {}) {
  return [{ value: '', label: none }, ...db.places.filter((p) => p.id !== HOME_ID).map((p) => ({ value: p.id, label: p.name }))];
}

function originOptions(db) {
  return [{ value: 'auto', label: 'Auto (home, or the previous stop if back-to-back)' }, { value: HOME_ID, label: 'Always from home' }, ...db.places.filter((p) => p.id !== HOME_ID).map((p) => ({ value: p.id, label: `From ${p.name}` }))];
}

function editOccurrence(ctx, o) {
  const base = baseOf(ctx, o);
  const ex = o.exception || {};
  const start = input({ type: 'time', value: o.startMin != null ? minToHM(o.startMin) : '' });
  const end = input({ type: 'time', value: o.endMin != null && o.endMin !== o.startMin ? minToHM(o.endMin) : '' });
  let lastStart = start.value;
  start.addEventListener('change', () => {
    if (isHM(lastStart) && isHM(start.value) && isHM(end.value)) end.value = minToHM(hmToMin(end.value) + hmToMin(start.value) - hmToMin(lastStart));
    lastStart = start.value;
  });
  const place = select(placeOptions(ctx.db), o.placeId || '');
  const origin = select(originOptions(ctx.db), ex.origin || 'auto');
  const note = input({ value: ex.note || '', placeholder: 'e.g. Makeup lesson, different room' });
  const err = h('div', { class: 'form-error', hidden: true });
  openModal({
    title: `${o.title}: ${fmtDate(o.date, { weekday: 'short', month: 'short', day: 'numeric' })}`,
    body: h('div', { class: 'form' },
      h('p', { class: 'muted' }, 'Changes apply to this date only.'),
      h('div', { class: 'row2' }, field('Start', start), field('End', end)),
      field('Place', place),
      field('Leave from', origin),
      field('Note', note),
      err),
    actions: [
      { label: 'Cancel', ghost: true },
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          const patch = {
            start: isHM(start.value) && (base.startMin == null || hmToMin(start.value) !== base.startMin) ? start.value : undefined,
            end: isHM(end.value) && hmToMin(end.value) !== base.endMin ? end.value : undefined,
            place: (place.value || null) !== (base.placeId || null) ? (place.value || null) : undefined,
            origin: origin.value !== 'auto' ? origin.value : undefined,
            note: note.value.trim() || undefined,
          };
          const fn = (d) => {
            upsertException(d, o.sourceId, o.date, { start: undefined, end: undefined, place: undefined, origin: undefined, note: undefined, variant: ex.variant, status: ex.status });
            upsertException(d, o.sourceId, o.date, patch);
          };
          const errors = precheck(ctx, fn);
          if (errors.length) {
            formError(err, errors);
            return true;
          }
          return !(await save(ctx, fn, `Change ${o.title} on ${o.date}`, 'Saved for that date'));
        },
      },
    ],
  });
}

function editEarlyRelease(ctx, o) {
  const s = ctx.db.schedules.find((x) => x.id === o.sourceId);
  const cal = ctx.db.calendars.find((c) => c.id === s?.calendar);
  const idx = cal?.days?.findIndex((e) => e.type === 'early_release' && o.date >= e.start && o.date <= (e.end || e.start));
  if (!cal || idx == null || idx < 0) {
    toast('No early-release day found in the school calendar for this date.', { kind: 'error' });
    return;
  }
  const entry = cal.days[idx];
  const t = input({ type: 'time', value: entry.dismissal || '' });
  const span = entry.end && entry.end !== entry.start;
  openModal({
    title: `${cal.short || cal.name}: early release`,
    body: h('div', { class: 'form' },
      h('p', null, `${entry.label}, ${span ? `${fmtDate(entry.start)} – ${fmtDate(entry.end)}` : fmtDateMedium(entry.start)}`),
      field('Dismissal time', t, span ? 'Applies to every day in this range.' : 'Pickups that day move to this time.')),
    actions: [
      { label: 'Cancel', ghost: true },
      { label: 'Clear', ghost: true, onClick: async () => !(await save(ctx, (d) => { delete d.calendars.find((c) => c.id === cal.id).days[idx].dismissal; }, 'Clear early release time', 'Cleared')) },
      { label: 'Save', primary: true, onClick: async () => { if (!isHM(t.value)) { toast('Pick a time.', { kind: 'error' }); return true; } return !(await save(ctx, (d) => { d.calendars.find((c) => c.id === cal.id).days[idx].dismissal = t.value; }, `Early release time for ${entry.label}`, `Pickup moved to ${fmt12(hmToMin(t.value))}`)); } },
    ],
  });
}

// ---- recurring items -------------------------------------------------------------

function memberOptions(db) {
  return db.members.map((m) => ({ value: m.id, label: m.name, color: m.color }));
}

function variantsEditor(list) {
  const rows = (list || []).map((v) => ({ ...v }));
  const wrap = h('div', { class: 'variants' });
  const render = () => {
    clear(wrap);
    rows.forEach((v, i) => {
      const label = input({ value: v.label || '', placeholder: 'e.g. Makeup class booked' });
      const dur = input({ type: 'number', min: '5', step: '5', value: v.durationMin ?? '', placeholder: 'min', class: 'num' });
      label.addEventListener('input', () => { v.label = label.value; });
      dur.addEventListener('input', () => { v.durationMin = numOrNull(dur.value); });
      wrap.append(h('div', { class: 'variant-row' }, label, dur, h('span', { class: 'muted' }, 'min'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove', onclick: () => { rows.splice(i, 1); render(); } }, icon('trash'))));
    });
    wrap.append(h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => { rows.push({ label: '', durationMin: null }); render(); } }, icon('plus'), 'Add a longer/shorter version'));
  };
  render();
  return {
    el: wrap,
    get: () => {
      const taken = new Set();
      return rows.filter((v) => v.label?.trim()).map((v) => {
        const id = v.id && !taken.has(v.id) ? v.id : uniqueId(v.label, taken);
        taken.add(id);
        return cleanObject({ id, label: v.label.trim(), durationMin: v.durationMin ?? undefined });
      });
    },
  };
}

function arriveControl(item) {
  const sel = select([
    { value: '0', label: 'At the start time' },
    { value: '5', label: '5 min early' },
    { value: '10', label: '10 min early' },
    { value: '15', label: '15 min early' },
    { value: 'custom', label: 'At a set time…' },
  ], isHM(item.arrive) ? 'custom' : String(item.arriveEarlyMin ?? 0));
  const early = String(item.arriveEarlyMin ?? 0);
  if (!isHM(item.arrive) && !['0', '5', '10', '15'].includes(early)) {
    sel.append(h('option', { value: early, selected: true }, `${early} min early`));
  }
  const t = input({ type: 'time', value: item.arrive || '', hidden: sel.value !== 'custom' });
  sel.addEventListener('change', () => { t.hidden = sel.value !== 'custom'; });
  return {
    el: h('div', { class: 'row2 tight' }, sel, t),
    get: () => (sel.value === 'custom' ? { arrive: isHM(t.value) ? t.value : undefined, arriveEarlyMin: undefined } : { arrive: undefined, arriveEarlyMin: Number(sel.value) || undefined }),
  };
}

export function editSchedule(ctx, id, preset = {}) {
  const db = ctx.db;
  const existing = id ? db.schedules.find((s) => s.id === id) : null;
  const s = existing ? structuredClone(existing) : { kind: 'activity', days: [], alarms: 'both', arriveEarlyMin: 5, ...preset };
  const title = input({ value: s.title || '', placeholder: 'e.g. Swim lesson', required: true });
  const emoji = input({ value: s.emoji || '', placeholder: '🏊', maxlength: '8', class: 'emoji-input' });
  const who = chips(memberOptions(db), s.who || []);
  const kind = select(Object.entries(KINDS).map(([value, label]) => ({ value, label })), s.kind || 'activity');
  const days = chips(DAY_OPTIONS, s.days || []);
  const startMin = isHM(s.start) ? hmToMin(s.start) : null;
  const endHM = isHM(s.end) ? s.end : startMin != null && Number.isFinite(s.durationMin) ? minToHM(startMin + s.durationMin) : '';
  const start = input({ type: 'time', value: s.start || '' });
  const end = input({ type: 'time', value: endHM });
  const tbd = checkbox('Time not decided yet (shows as TBD)', s.tbd);
  const arrive = arriveControl(s);
  const place = select(placeOptions(db), s.place || '');
  const origin = select(originOptions(db), s.origin || 'auto');
  const calendar = select([{ value: '', label: 'Not tied to a school calendar' }, ...db.calendars.map((c) => ({ value: c.id, label: c.name }))], s.calendar || '');
  const calMode = select(Object.entries(CAL_MODES).map(([value, label]) => ({ value, label })), s.calendarMode || 'school_days');
  const early = select([{ value: '', label: 'Early release: no change' }, { value: 'pickup', label: 'Early release: move to dismissal time' }], s.earlyRelease || '');
  const calRow = h('div', { class: 'row2', hidden: !s.calendar }, calMode, early);
  calendar.addEventListener('change', () => { calRow.hidden = !calendar.value; });
  const from = input({ type: 'date', value: s.from || '' });
  const until = input({ type: 'date', value: s.until || '' });
  const alarms = select(Object.entries(ALARM_MODES).map(([value, label]) => ({ value, label })), s.alarms || 'both');
  const variants = variantsEditor(s.variants);
  const notes = textarea(s.notes || '', { rows: 3, placeholder: 'Teacher, what to bring, how to cancel…' });
  const err = h('div', { class: 'form-error', hidden: true });

  const build = () => {
    const out = { ...s };
    out.title = title.value.trim();
    out.emoji = emoji.value.trim() || undefined;
    out.who = who.get();
    out.kind = kind.value;
    out.days = days.get();
    out.start = isHM(start.value) ? start.value : null;
    out.end = isHM(end.value) ? end.value : undefined;
    out.durationMin = undefined;
    out.tbd = tbd.box.checked || !out.start ? true : undefined;
    Object.assign(out, arrive.get());
    out.place = place.value || null;
    out.origin = origin.value !== 'auto' ? origin.value : undefined;
    out.calendar = calendar.value || undefined;
    out.calendarMode = calendar.value ? calMode.value : undefined;
    out.earlyRelease = calendar.value && early.value ? early.value : undefined;
    out.from = from.value || undefined;
    out.until = until.value || undefined;
    out.alarms = alarms.value;
    const v = variants.get();
    out.variants = v.length ? v : undefined;
    out.notes = notes.value.trim() || undefined;
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    if (!out.id) out.id = uniqueId(out.title || 'item', db.schedules.map((x) => x.id));
    return out;
  };

  const actions = [{ label: 'Cancel', ghost: true }];
  if (existing) {
    actions.push({
      label: 'Delete',
      danger: true,
      onClick: async () => {
        const refs = db.exceptions.filter((x) => x.schedule === existing.id).length;
        if (!(await confirmDialog(`Delete "${existing.title}"?`, `This removes every future occurrence${refs ? ` and ${refs} saved change${refs === 1 ? '' : 's'}` : ''}. To keep its history, set an "Until" date instead.`, { confirmLabel: 'Delete', danger: true }))) return true;
        return !(await save(ctx, (d) => { d.schedules = d.schedules.filter((x) => x.id !== existing.id); d.exceptions = d.exceptions.filter((x) => x.schedule !== existing.id); }, `Delete ${existing.title}`, 'Deleted'));
      },
    });
  }
  actions.push({
    label: existing ? 'Save' : 'Add',
    primary: true,
    onClick: async () => {
      const item = build();
      const fn = (d) => {
        const i = d.schedules.findIndex((x) => x.id === item.id);
        if (i >= 0) d.schedules[i] = item;
        else d.schedules.push(item);
      };
      const errors = precheck(ctx, fn);
      if (errors.length) {
        formError(err, errors);
        return true;
      }
      return !(await save(ctx, fn, `${existing ? 'Edit' : 'Add'} ${item.title}`, existing ? 'Saved' : 'Added'));
    },
  });

  openModal({
    title: existing ? `Edit: ${existing.title}` : 'New recurring item',
    wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'row-title' }, field('Title', title), field('Emoji', emoji)),
      field('Who', who.el),
      field('Repeats on', days.el),
      h('div', { class: 'row2' }, field('Start', start), field('End', end)),
      tbd.el,
      h('div', { class: 'row2' }, field('Type', kind), field('Alerts', alarms)),
      field('Where', place),
      field('Get there', arrive.el),
      field('Leave from', origin),
      field('School calendar', calendar, 'Skip school runs on days off, or just flag days off for activities.'),
      calRow,
      h('div', { class: 'row2' }, field('From (optional)', from), field('Until (optional)', until)),
      field('Other versions', variants.el, 'For example a makeup class that runs an hour instead of 30 minutes. Pick it per date from the ⋯ menu.'),
      field('Notes', notes),
      err),
    actions,
  });
}

// ---- one-off events --------------------------------------------------------------

export function editEvent(ctx, id, preset = {}) {
  const db = ctx.db;
  const existing = id ? db.events.find((e) => e.id === id) : null;
  const e = existing ? structuredClone(existing) : { date: preset.date || ctx.today(), alarms: 'both', travel: true, ...preset };
  const title = input({ value: e.title || '', placeholder: 'e.g. Dentist, birthday party, field trip' });
  const emoji = input({ value: e.emoji || '', placeholder: '📌', maxlength: '8', class: 'emoji-input' });
  const date = input({ type: 'date', value: e.date || '' });
  const allDay = checkbox('All day (no time)', e.allDay);
  const start = input({ type: 'time', value: e.start || '' });
  const end = input({ type: 'time', value: e.end || '' });
  const timeRow = h('div', { class: 'row2', hidden: !!e.allDay }, field('Start', start), field('End', end));
  allDay.box.addEventListener('change', () => { timeRow.hidden = allDay.box.checked; });
  const who = chips(memberOptions(db), e.who || []);
  const place = select(placeOptions(db, { none: 'No place' }), e.place || '');
  const travel = checkbox('Plan the drive and alert me when to leave', e.travel !== false);
  const alarms = select(Object.entries(ALARM_MODES).map(([value, label]) => ({ value, label })), e.alarms || 'both');
  const notes = textarea(e.notes || '', { rows: 3 });
  const err = h('div', { class: 'form-error', hidden: true });
  const build = () => {
    const out = { ...e };
    out.title = title.value.trim();
    out.emoji = emoji.value.trim() || undefined;
    out.date = date.value;
    out.allDay = allDay.box.checked || undefined;
    out.start = !out.allDay && isHM(start.value) ? start.value : undefined;
    out.end = !out.allDay && isHM(end.value) ? end.value : undefined;
    out.who = who.get();
    out.place = place.value || undefined;
    out.travel = travel.box.checked ? undefined : false;
    out.alarms = alarms.value;
    out.notes = notes.value.trim() || undefined;
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    if (!out.id) out.id = uniqueId(`${out.title}-${out.date}`, db.events.map((x) => x.id));
    return out;
  };
  const actions = [{ label: 'Cancel', ghost: true }];
  if (existing) actions.push({ label: 'Delete', danger: true, onClick: async () => !(await save(ctx, (d) => { d.events = d.events.filter((x) => x.id !== existing.id); }, `Delete ${existing.title}`, 'Deleted')) });
  actions.push({
    label: existing ? 'Save' : 'Add',
    primary: true,
    onClick: async () => {
      const item = build();
      const fn = (d) => {
        const i = d.events.findIndex((x) => x.id === item.id);
        if (i >= 0) d.events[i] = item;
        else d.events.push(item);
        d.events.sort((a, b) => a.date.localeCompare(b.date) || String(a.start || '').localeCompare(String(b.start || '')));
      };
      const errors = precheck(ctx, fn);
      if (errors.length) {
        formError(err, errors);
        return true;
      }
      return !(await save(ctx, fn, `${existing ? 'Edit' : 'Add'} ${item.title}`, existing ? 'Saved' : 'Added'));
    },
  });
  openModal({
    title: existing ? `Edit: ${existing.title}` : 'New one-off',
    wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'row-title' }, field('Title', title), field('Emoji', emoji)),
      h('div', { class: 'row2' }, field('Date', date), h('div', { class: 'field field-check' }, allDay.el)),
      timeRow,
      field('Who', who.el),
      field('Where', place),
      travel.el,
      field('Alerts', alarms),
      field('Notes', notes),
      err),
    actions,
  });
}

// ---- places & drive times ------------------------------------------------------------

// Runs one lookup at a time; a request made mid-run goes next, so it sees
// the newest data (e.g. a home address saved while venues were being found).
let locating = Promise.resolve();
export function locateAndRoute(ctx, opts = {}) {
  locating = locating.catch(() => {}).then(() => runLocate(ctx, opts));
  return locating;
}

async function runLocate(ctx, { quiet = false } = {}) {
  const db = ctx.db;
  const coords = {};
  const problems = [];
  for (const p of db.places) {
    if (hasCoords(p) || !p.address) continue;
    try {
      const r = await geocode(p.address);
      if (r) coords[p.id] = { lat: r.lat, lng: r.lng };
      else problems.push(`${p.name}: address not found. Paste its coordinates from Maps instead.`);
    } catch (e) {
      problems.push(`${p.name}: ${e.message}`);
    }
  }
  const draft = normalizeDb(structuredClone(db));
  for (const p of draft.places) if (coords[p.id]) Object.assign(p, coords[p.id]);
  const today = todayIn(draft.meta.timezone, ctx.now());
  const index = makeIndex(draft);
  const occs = planTrips(draft, expand(draft, today, addDays(today, 28), index), index);
  const routes = {};
  for (const [a, b] of wantedRoutes(draft, occs, index)) {
    const pa = index.places.get(a);
    const pb = index.places.get(b);
    try {
      const r = await roadRoute(pa, pb);
      routes[routeKey(a, b)] = { min: r.min, km: r.km, from: coordKey(pa), to: coordKey(pb), at: today };
    } catch (e) {
      problems.push(`${pa.name} → ${pb.name}: ${e.message}`);
      break; // the router is down or blocked; don't hammer it
    }
    await new Promise((r) => setTimeout(r, 1000)); // the free routing server asks for at most ~1 request/second
  }
  const nCoords = Object.keys(coords).length;
  const nRoutes = Object.keys(routes).length;
  if (nCoords || nRoutes) {
    await save(ctx, (d) => {
      for (const p of d.places) if (coords[p.id]) Object.assign(p, coords[p.id]);
      Object.assign(d.routes.cache, routes);
    }, 'Update locations and drive times');
  }
  if (!quiet || problems.length) {
    const parts = [];
    if (nCoords) parts.push(`found ${nCoords} place${nCoords === 1 ? '' : 's'} on the map`);
    if (nRoutes) parts.push(`updated ${nRoutes} drive time${nRoutes === 1 ? '' : 's'}`);
    const msg = parts.length ? `${parts.join(' and ').replace(/^./, (c) => c.toUpperCase())}.` : 'Drive times are already up to date.';
    toast(problems.length ? `${msg} ${problems[0]}` : msg, { kind: problems.length ? 'warn' : 'ok', ms: problems.length ? 8000 : 3500 });
  }
  return { nCoords, nRoutes, problems };
}

function editPlace(ctx, id) {
  const db = ctx.db;
  const existing = id ? db.places.find((p) => p.id === id) : null;
  const p = existing ? structuredClone(existing) : { bufferMin: 5 };
  const isHome = p.id === HOME_ID;
  const name = input({ value: p.name || '', disabled: isHome });
  const short = input({ value: p.short || '', placeholder: 'Short name for cards' });
  const address = input({ value: p.address || '', placeholder: 'Street, City, State ZIP', autocomplete: isHome ? 'street-address' : 'off' });
  const ll = input({ value: hasCoords(p) ? `${p.lat}, ${p.lng}` : '', placeholder: 'Filled in automatically, or paste "40.7128, -74.0060"' });
  const buffer = input({ type: 'number', min: '0', step: '1', value: p.bufferMin ?? 5, class: 'num' });
  const phone = input({ type: 'tel', value: p.phone || '' });
  const notes = textarea(p.notes || '', { rows: 2 });
  const status = h('small', { class: 'muted' });
  const locate = h('button', { type: 'button', class: 'btn btn-small', onclick: async () => {
    if (!address.value.trim()) return;
    locate.disabled = true;
    status.textContent = 'Looking up…';
    try {
      const r = await geocode(address.value);
      if (r) {
        ll.value = `${r.lat}, ${r.lng}`;
        status.textContent = `Found: ${r.label}`;
      } else status.textContent = 'Not found. Open the place in Apple or Google Maps, copy its coordinates and paste them above.';
    } catch (e) {
      status.textContent = e.message;
    } finally {
      locate.disabled = false;
    }
  } }, icon('pin'), 'Find on map');
  address.addEventListener('change', () => { if (existing && address.value !== existing.address) ll.value = ''; });
  const err = h('div', { class: 'form-error', hidden: true });
  const actions = [{ label: 'Cancel', ghost: true }];
  if (existing && !isHome) {
    actions.push({ label: 'Delete', danger: true, onClick: async () => {
      const errors = precheck(ctx, (d) => { d.places = d.places.filter((x) => x.id !== existing.id); });
      if (errors.length) { formError(err, ['This place is still used:', ...errors]); return true; }
      return !(await save(ctx, (d) => { d.places = d.places.filter((x) => x.id !== existing.id); }, `Delete place ${existing.name}`, 'Deleted'));
    } });
  }
  actions.push({
    label: existing ? 'Save' : 'Add',
    primary: true,
    onClick: async () => {
      const c = parseLatLng(ll.value);
      if (ll.value.trim() && !c) { formError(err, ['Coordinates should look like "40.7128, -74.0060".']); return true; }
      let coords = c;
      if (!coords && address.value.trim()) {
        status.textContent = 'Looking up the address…';
        try { const r = await geocode(address.value); if (r) coords = { lat: r.lat, lng: r.lng }; } catch { /* save without coordinates */ }
      }
      const item = cleanObject({
        ...p,
        id: p.id || uniqueId(name.value, db.places.map((x) => x.id)),
        name: isHome ? 'Home' : name.value.trim(),
        short: short.value.trim() || undefined,
        address: address.value.trim(),
        lat: coords ? coords.lat : null,
        lng: coords ? coords.lng : null,
        bufferMin: numOrNull(buffer.value) ?? 0,
        phone: phone.value.trim() || undefined,
        notes: notes.value.trim() || undefined,
      });
      item.lat = coords ? coords.lat : null;
      item.lng = coords ? coords.lng : null;
      if (isHome) item.address = item.address || '';
      const fn = (d) => {
        const i = d.places.findIndex((x) => x.id === item.id);
        if (i >= 0) d.places[i] = item;
        else d.places.push(item);
      };
      const errors = precheck(ctx, fn);
      if (errors.length) { formError(err, errors); return true; }
      const ok = await save(ctx, fn, `${existing ? 'Edit' : 'Add'} place ${item.name}`, coords ? 'Saved. Updating drive times…' : 'Saved (no map location yet)');
      if (ok && coords) locateAndRoute(ctx).catch(() => {}); // runs on after the dialog closes
      return !ok;
    },
  });
  openModal({
    title: isHome ? 'Home address' : existing ? `Edit: ${existing.name}` : 'New place',
    wide: true,
    body: h('div', { class: 'form' },
      isHome ? h('p', { class: 'muted' }, 'Stays in your private data repo. Used only to work out drive times.') : null,
      isHome ? null : h('div', { class: 'row2' }, field('Name', name), field('Short name', short)),
      field('Address', address),
      h('div', { class: 'row-locate' }, field('Map location', ll), locate),
      status,
      isHome ? null : h('div', { class: 'row2' }, field('Buffer (min)', buffer, 'Parking, walking in, check-in.'), field('Phone', phone)),
      isHome ? null : field('Notes', notes),
      err),
    actions,
  });
}

function editDriveTime(ctx, fromId, toId) {
  const key = routeKey(fromId, toId);
  const places = makeIndex(ctx.db).places;
  const cur = baseDrive(ctx.db, fromId, toId, places);
  const ov = ctx.db.routes.overrides[key];
  const mins = input({ type: 'number', min: '0', step: '1', value: Number.isFinite(ov) ? ov : '', placeholder: String(Math.round(cur.min)), class: 'num' });
  openModal({
    title: `${placeLabel(places.get(fromId))} → ${placeLabel(places.get(toId))}`,
    body: h('div', { class: 'form' },
      h('p', null, `Now using ${Math.round(cur.min)} min (${describeSource(cur.src)}), before traffic padding.`),
      field('Your own estimate (minutes, no traffic)', mins, 'Leave empty to use the road route.')),
    actions: [
      { label: 'Cancel', ghost: true },
      { label: 'Save', primary: true, onClick: async () => !(await save(ctx, (d) => {
        const v = numOrNull(mins.value);
        if (v == null) delete d.routes.overrides[key];
        else d.routes.overrides[key] = v;
      }, 'Drive time override', 'Saved')) },
    ],
  });
}

// ---- calendars -------------------------------------------------------------------

function editCalendar(ctx, id) {
  const db = ctx.db;
  const existing = id ? db.calendars.find((c) => c.id === id) : null;
  const c = existing ? structuredClone(existing) : { color: '#0EA5E9', days: [] };
  const name = input({ value: c.name || '', placeholder: 'e.g. Lincoln Elementary 2026–27' });
  const short = input({ value: c.short || '', placeholder: 'e.g. Lincoln' });
  const color = input({ type: 'color', value: c.color || '#0EA5E9' });
  const first = input({ type: 'date', value: c.firstDay || '' });
  const last = input({ type: 'date', value: c.lastDay || '' });
  const verify = checkbox('These dates still need checking', c.verify);
  const source = input({ value: c.source || '', placeholder: 'Link to the official calendar' });
  const notes = textarea(c.notes || '', { rows: 2 });
  const err = h('div', { class: 'form-error', hidden: true });
  const actions = [{ label: 'Cancel', ghost: true }];
  if (existing) actions.push({ label: 'Delete', danger: true, onClick: async () => {
    const errors = precheck(ctx, (d) => { d.calendars = d.calendars.filter((x) => x.id !== existing.id); });
    if (errors.length) { formError(err, ['This calendar is still used:', ...errors]); return true; }
    if (!(await confirmDialog('Delete this calendar?', `${existing.name} and its ${existing.days.length} dates will be removed.`, { confirmLabel: 'Delete', danger: true }))) return true;
    return !(await save(ctx, (d) => { d.calendars = d.calendars.filter((x) => x.id !== existing.id); }, `Delete calendar ${existing.name}`, 'Deleted'));
  } });
  actions.push({ label: existing ? 'Save' : 'Add', primary: true, onClick: async () => {
    const item = cleanObject({ ...c, id: c.id || uniqueId(short.value || name.value, db.calendars.map((x) => x.id)), name: name.value.trim(), short: short.value.trim() || undefined, color: color.value, firstDay: first.value || undefined, lastDay: last.value || undefined, verify: verify.box.checked || undefined, source: source.value.trim() || undefined, notes: notes.value.trim() || undefined });
    item.days = c.days || [];
    const fn = (d) => { const i = d.calendars.findIndex((x) => x.id === item.id); if (i >= 0) d.calendars[i] = item; else d.calendars.push(item); };
    const errors = precheck(ctx, fn);
    if (errors.length) { formError(err, errors); return true; }
    return !(await save(ctx, fn, `${existing ? 'Edit' : 'Add'} calendar ${item.name}`, 'Saved'));
  } });
  openModal({
    title: existing ? `Edit: ${existing.name}` : 'New school calendar',
    wide: true,
    body: h('div', { class: 'form' },
      h('div', { class: 'row2' }, field('Name', name), field('Short name', short)),
      h('div', { class: 'row3' }, field('First day', first), field('Last day', last), field('Color', color)),
      verify.el,
      field('Source', source),
      field('Notes', notes),
      err),
    actions,
  });
}

function editCalendarDay(ctx, calId, index) {
  const cal = ctx.db.calendars.find((c) => c.id === calId);
  const existing = index != null ? cal.days[index] : null;
  const e = existing ? { ...existing } : { type: 'no_school' };
  const type = select(Object.entries(DAY_TYPES).map(([value, label]) => ({ value, label })), e.type);
  const label = input({ value: e.label || '', placeholder: 'e.g. Spring Break' });
  const start = input({ type: 'date', value: e.start || '' });
  const end = input({ type: 'date', value: e.end || '' });
  const dismissal = input({ type: 'time', value: e.dismissal || '' });
  const disRow = field('Dismissal time', dismissal, 'Pickups set to move on early release use this time.');
  disRow.hidden = type.value !== 'early_release';
  type.addEventListener('change', () => { disRow.hidden = type.value !== 'early_release'; });
  const err = h('div', { class: 'form-error', hidden: true });
  const actions = [{ label: 'Cancel', ghost: true }];
  if (existing) actions.push({ label: 'Delete', danger: true, onClick: async () => !(await save(ctx, (d) => { d.calendars.find((c) => c.id === calId).days.splice(index, 1); }, `Remove ${existing.label}`, 'Removed')) });
  actions.push({ label: existing ? 'Save' : 'Add', primary: true, onClick: async () => {
    const item = cleanObject({ type: type.value, label: label.value.trim(), start: start.value, end: end.value && end.value !== start.value ? end.value : undefined, dismissal: type.value === 'early_release' && isHM(dismissal.value) ? dismissal.value : undefined });
    if (!item.label) item.label = DAY_TYPES[item.type];
    const fn = (d) => {
      const days = d.calendars.find((c) => c.id === calId).days;
      if (existing) days[index] = item;
      else days.push(item);
      days.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    };
    const errors = precheck(ctx, fn);
    if (errors.length) { formError(err, errors); return true; }
    return !(await save(ctx, fn, `${existing ? 'Edit' : 'Add'} ${item.label} (${cal.short || cal.name})`, 'Saved'));
  } });
  openModal({
    title: existing ? `${cal.short || cal.name}: ${existing.label}` : `${cal.short || cal.name}: add a date`,
    body: h('div', { class: 'form' }, field('Type', type), field('Label', label), h('div', { class: 'row2' }, field('From', start), field('To (optional)', end)), disRow, err),
    actions,
  });
}

function editHoliday(ctx, index) {
  const existing = index != null ? ctx.db.holidays[index] : null;
  const date = input({ type: 'date', value: existing?.date || '' });
  const name = input({ value: existing?.name || '', placeholder: 'e.g. Thanksgiving' });
  const err = h('div', { class: 'form-error', hidden: true });
  const actions = [{ label: 'Cancel', ghost: true }];
  if (existing) actions.push({ label: 'Delete', danger: true, onClick: async () => !(await save(ctx, (d) => { d.holidays.splice(index, 1); }, `Remove holiday ${existing.name}`, 'Removed')) });
  actions.push({ label: existing ? 'Save' : 'Add', primary: true, onClick: async () => {
    const item = { date: date.value, name: name.value.trim() };
    const fn = (d) => {
      if (existing) d.holidays[index] = item;
      else d.holidays.push(item);
      d.holidays.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    };
    const errors = precheck(ctx, fn);
    if (errors.length) { formError(err, errors); return true; }
    return !(await save(ctx, fn, `${existing ? 'Edit' : 'Add'} holiday ${item.name}`, 'Saved'));
  } });
  openModal({
    title: existing ? `Holiday: ${existing.name}` : 'Add a holiday',
    body: h('div', { class: 'form' }, h('p', { class: 'muted small' }, 'Activities that fall on this date ask "is it on?" until you confirm or cancel them.'), h('div', { class: 'row2' }, field('Date', date), field('Name', name)), err),
    actions,
  });
}

// ---- family ---------------------------------------------------------------------

function editMember(ctx, id) {
  const db = ctx.db;
  const existing = id ? db.members.find((m) => m.id === id) : null;
  const m = existing ? structuredClone(existing) : { role: 'kid', color: '#0EA5E9' };
  const name = input({ value: m.name || '' });
  const role = select([{ value: 'kid', label: 'Kid' }, { value: 'parent', label: 'Parent' }, { value: 'other', label: 'Other (sitter, grandparent…)' }], m.role);
  const dob = input({ type: 'date', value: m.dob || '' });
  const color = input({ type: 'color', value: m.color || '#0EA5E9' });
  const grade = input({ value: m.school?.grade || '', placeholder: 'e.g. 4th grade' });
  const school = select([{ value: '', label: 'None' }, ...db.places.filter((p) => p.id !== HOME_ID).map((p) => ({ value: p.id, label: p.name }))], m.school?.place || '');
  const cal = select([{ value: '', label: 'None' }, ...db.calendars.map((c) => ({ value: c.id, label: c.name }))], m.school?.calendar || '');
  const notes = textarea(m.notes || '', { rows: 3 });
  const kidOnly = h('div', { class: 'form', hidden: m.role !== 'kid' }, h('div', { class: 'row2' }, field('Date of birth', dob), field('Color', color)), field('Grade / class', grade), h('div', { class: 'row2' }, field('School', school), field('School calendar', cal)));
  role.addEventListener('change', () => { kidOnly.hidden = role.value !== 'kid'; });
  const err = h('div', { class: 'form-error', hidden: true });
  const actions = [{ label: 'Cancel', ghost: true }];
  if (existing) actions.push({ label: 'Delete', danger: true, onClick: async () => {
    const errors = precheck(ctx, (d) => { d.members = d.members.filter((x) => x.id !== existing.id); });
    if (errors.length) { formError(err, [`${existing.name} is still on:`, ...errors]); return true; }
    return !(await save(ctx, (d) => { d.members = d.members.filter((x) => x.id !== existing.id); }, `Remove ${existing.name}`, 'Removed'));
  } });
  actions.push({ label: existing ? 'Save' : 'Add', primary: true, onClick: async () => {
    const item = cleanObject({ ...m, id: m.id || uniqueId(name.value, db.members.map((x) => x.id)), name: name.value.trim(), role: role.value, dob: role.value === 'kid' ? dob.value || undefined : m.dob, color: role.value === 'kid' ? color.value : m.color, notes: notes.value.trim() || undefined });
    const sch = cleanObject({ ...(m.school || {}), place: school.value || undefined, calendar: cal.value || undefined, grade: grade.value.trim() || undefined });
    if (role.value === 'kid' && Object.keys(sch).length) item.school = sch;
    else delete item.school;
    const fn = (d) => { const i = d.members.findIndex((x) => x.id === item.id); if (i >= 0) d.members[i] = item; else d.members.push(item); };
    const errors = precheck(ctx, fn);
    if (errors.length) { formError(err, errors); return true; }
    return !(await save(ctx, fn, `${existing ? 'Edit' : 'Add'} ${item.name}`, 'Saved'));
  } });
  openModal({
    title: existing ? `Edit: ${existing.name}` : 'Add a person',
    wide: true,
    body: h('div', { class: 'form' }, h('div', { class: 'row2' }, field('Name', name), field('Role', role)), kidOnly, field('Notes', notes), err),
    actions,
  });
}

// ---- Manage screens -----------------------------------------------------------------

const SECTIONS = [
  ['schedules', 'Recurring'],
  ['events', 'One-offs'],
  ['changes', 'Changes'],
  ['places', 'Places & drives'],
  ['calendars', 'School calendars'],
  ['family', 'Family'],
  ['alerts', 'Alerts'],
  ['feed', 'Calendar feed'],
  ['data', 'Data & sync'],
];

const listRow = (main, actions) => h('div', { class: 'lrow' }, h('div', { class: 'lrow-main' }, main), h('div', { class: 'lrow-actions' }, actions));
const editBtn = (onclick, label = 'Edit') => h('button', { class: 'btn btn-small', onclick }, icon('edit'), label);
const addBtn = (label, onclick) => h('button', { class: 'btn btn-primary btn-small', onclick }, icon('plus'), label);

function schedulesSection(ctx) {
  const db = ctx.db;
  const rank = (s) => Math.min(...(s.days || ['SU']).map((d) => (DOW.indexOf(d) + 6) % 7));
  const list = [...db.schedules].sort((a, b) => (a.kind === 'school' ? 0 : 1) - (b.kind === 'school' ? 0 : 1) || rank(a) - rank(b) || String(a.start || '99').localeCompare(String(b.start || '99')));
  return [
    h('div', { class: 'section-head' }, h('h2', null, 'Recurring'), addBtn('Add', () => editSchedule(ctx, null))),
    h('p', { class: 'muted' }, 'Weekly school runs and activities. Change a single date from its ⋯ menu on the Today screen.'),
    list.map((s) => {
      const place = db.places.find((p) => p.id === s.place);
      const st = isHM(s.start) ? hmToMin(s.start) : null;
      const en = isHM(s.end) ? hmToMin(s.end) : st != null && s.durationMin ? st + s.durationMin : null;
      return listRow([
        h('div', { class: 'lrow-title' }, `${s.emoji ? `${s.emoji} ` : ''}${s.title}`, s.tbd ? h('span', { class: 'badge badge-warn' }, 'Time TBD') : null, s.until && s.until < ctx.today() ? h('span', { class: 'badge badge-muted' }, 'Ended') : null),
        h('div', { class: 'lrow-sub' }, `${fmtDays(s.days)} · ${st != null && !s.tbd ? `${fmt12(st)}${en != null && en !== st ? `–${fmt12(en)}` : ''}` : 'time TBD'}${place ? ` · ${place.name}` : ''}`),
        h('div', { class: 'lrow-sub' }, (s.who || []).map((w) => db.members.find((m) => m.id === w)?.name || w).join(', '), s.calendar ? ` · follows ${db.calendars.find((c) => c.id === s.calendar)?.short || s.calendar}` : '', s.from ? ` · from ${fmtDate(s.from, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''),
      ], editBtn(() => editSchedule(ctx, s.id)));
    }),
  ];
}

function eventsSection(ctx) {
  const today = ctx.today();
  const upcoming = ctx.db.events.filter((e) => e.date >= today);
  const past = ctx.db.events.filter((e) => e.date < today);
  const row = (e) => listRow([
    h('div', { class: 'lrow-title' }, `${e.emoji ? `${e.emoji} ` : ''}${e.title}`, e.cancelled ? h('span', { class: 'badge badge-muted' }, 'Cancelled') : null),
    h('div', { class: 'lrow-sub' }, `${fmtDateMedium(e.date)} · ${e.allDay ? 'all day' : e.start ? `${fmt12(hmToMin(e.start))}${isHM(e.end) ? `–${fmt12(hmToMin(e.end))}` : ''}` : 'time TBD'}`),
  ], editBtn(() => editEvent(ctx, e.id)));
  return [
    h('div', { class: 'section-head' }, h('h2', null, 'One-offs'), addBtn('Add', () => editEvent(ctx, null))),
    upcoming.length ? upcoming.map(row) : h('p', { class: 'muted' }, 'Nothing coming up. Add parties, appointments, field trips…'),
    past.length ? h('details', { class: 'past' }, h('summary', null, `Past (${past.length})`), past.map(row)) : null,
  ];
}

function changesSection(ctx) {
  const db = ctx.db;
  const today = ctx.today();
  const pending = ctx.plan(today, addDays(today, 60)).filter((o) => o.status === 'check' || o.status === 'tbd');
  const exs = db.exceptions.filter((x) => x.date >= addDays(today, -14));
  const describe = (x) => [
    x.status === 'cancelled' ? 'Cancelled' : x.status === 'confirmed' ? 'Confirmed on' : x.status === 'check' ? 'Needs checking' : null,
    x.variant ? db.schedules.find((s) => s.id === x.schedule)?.variants?.find((v) => v.id === x.variant)?.label || x.variant : null,
    x.start ? `starts ${fmt12(hmToMin(x.start))}` : null,
    x.end ? `ends ${fmt12(hmToMin(x.end))}` : null,
    x.place !== undefined ? `at ${db.places.find((p) => p.id === x.place)?.name || 'no place'}` : null,
    x.note || null,
  ].filter(Boolean).join(' · ');
  return [
    h('div', { class: 'section-head' }, h('h2', null, 'Needs a decision')),
    pending.length ? pending.map((o) => listRow([
      h('div', { class: 'lrow-title' }, `${o.emoji ? `${o.emoji} ` : ''}${o.title}`, h('span', { class: 'badge badge-warn' }, o.status === 'tbd' ? (o.tbdReason === 'early_release' ? 'Early release time' : 'Time TBD') : o.holiday || 'Check')),
      h('div', { class: 'lrow-sub' }, fmtDateMedium(o.date)),
    ], h('button', { class: 'btn btn-small', onclick: () => ctx.openOccMenu(o) }, 'Decide…'))) : h('p', { class: 'muted' }, 'Nothing to decide in the next 60 days.'),
    h('div', { class: 'section-head' }, h('h2', null, 'Changes to single dates')),
    exs.length ? exs.map((x) => {
      const s = db.schedules.find((y) => y.id === x.schedule);
      return listRow([
        h('div', { class: 'lrow-title' }, `${s?.emoji ? `${s.emoji} ` : ''}${s?.title || x.schedule}`),
        h('div', { class: 'lrow-sub' }, `${fmtDateMedium(x.date)} · ${describe(x) || 'changed'}`),
      ], h('button', { class: 'btn btn-small', onclick: () => save(ctx, (d) => { d.exceptions = d.exceptions.filter((y) => !(y.schedule === x.schedule && y.date === x.date)); }, `Undo change to ${s?.title}`, 'Undone') }, icon('refresh'), 'Undo'));
    }) : h('p', { class: 'muted' }, 'No changes. Cancel or move a single date from its ⋯ menu.'),
  ];
}

function placesSection(ctx) {
  const db = ctx.db;
  const index = makeIndex(db);
  const home = index.places.get(HOME_ID);
  const others = db.places.filter((p) => p.id !== HOME_ID);
  const missing = db.places.filter((p) => p.address && !hasCoords(p)).length;
  return [
    h('div', { class: 'section-head' }, h('h2', null, 'Home')),
    listRow([
      h('div', { class: 'lrow-title' }, '🏠 Home', hasCoords(home) ? h('span', { class: 'badge badge-ok' }, 'on the map') : h('span', { class: 'badge badge-warn' }, 'not set')),
      h('div', { class: 'lrow-sub' }, home?.address || 'Add your address so leave-by times use real drive times.'),
    ], editBtn(() => editPlace(ctx, HOME_ID), home?.address ? 'Edit' : 'Set address')),
    h('div', { class: 'section-head' }, h('h2', null, 'Places'), addBtn('Add', () => editPlace(ctx, null))),
    others.map((p) => {
      const d = baseDrive(db, HOME_ID, p.id, index.places);
      return listRow([
        h('div', { class: 'lrow-title' }, p.name, hasCoords(p) ? null : h('span', { class: 'badge badge-warn' }, 'not on the map')),
        h('div', { class: 'lrow-sub' }, p.address || 'No address'),
        h('div', { class: 'lrow-sub' }, `From home: ${Math.round(d.min)} min (${describeSource(d.src)})${p.bufferMin ? ` · ${p.bufferMin} min buffer` : ''}`),
      ], [h('button', { class: 'btn btn-small btn-ghost', onclick: () => editDriveTime(ctx, HOME_ID, p.id) }, icon('car'), 'Drive'), editBtn(() => editPlace(ctx, p.id))]);
    }),
    h('div', { class: 'section-actions' },
      h('button', { class: 'btn', onclick: async (e) => { e.currentTarget.disabled = true; try { await locateAndRoute(ctx); } finally { e.currentTarget.disabled = false; } } }, icon('refresh'), missing ? `Find ${missing} on the map & update drive times` : 'Update drive times')),
    h('p', { class: 'muted small' }, 'Drive times come from OpenStreetMap road routing, then get padded for traffic (Alerts settings). Tap Directions on any item for live traffic in Maps.'),
  ];
}

function calendarsSection(ctx) {
  const db = ctx.db;
  const today = ctx.today();
  return [
    h('div', { class: 'section-head' }, h('h2', null, 'School calendars'), addBtn('Add', () => editCalendar(ctx, null))),
    db.calendars.map((c) => h('section', { class: 'cal-card', style: { '--mc': c.color || '#94a3b8' } },
      h('div', { class: 'cal-head' },
        h('div', null,
          h('h3', null, c.name, c.verify ? h('span', { class: 'badge badge-warn' }, 'verify') : null),
          h('p', { class: 'lrow-sub' }, `${c.firstDay ? fmtDateMedium(c.firstDay) : '?'} → ${c.lastDay ? fmtDateMedium(c.lastDay) : '?'}`),
          c.source ? (/^https?:/.test(c.source) ? h('a', { href: c.source, target: '_blank', rel: 'noopener', class: 'small' }, 'Official calendar') : h('p', { class: 'small muted' }, c.source)) : null,
          c.notes ? h('p', { class: 'small muted' }, c.notes) : null),
        editBtn(() => editCalendar(ctx, c.id))),
      h('ul', { class: 'cal-days' }, (c.days || []).map((d, i) => h('li', { class: `${(d.end || d.start) < today ? 'past' : ''} cal-${d.type}` },
        h('button', { class: 'cal-day', onclick: () => editCalendarDay(ctx, c.id, i) },
          h('span', { class: 'cal-when' }, d.end && d.end !== d.start ? `${fmtDate(d.start, { month: 'short', day: 'numeric' })} – ${fmtDate(d.end, { month: 'short', day: 'numeric' })}` : fmtDate(d.start)),
          h('span', { class: 'cal-what' }, d.label),
          h('span', { class: 'cal-type' }, d.type === 'early_release' ? (d.dismissal ? `Early release ${fmt12(hmToMin(d.dismissal))}` : 'Early release (time TBD)') : DAY_TYPES[d.type] || d.type))))),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => editCalendarDay(ctx, c.id, null) }, icon('plus'), 'Add a date'))),
    h('div', { class: 'section-head' }, h('h2', null, 'Holidays to double-check'), addBtn('Add', () => editHoliday(ctx, null))),
    h('p', { class: 'muted small' }, 'Lessons and classes on these dates are flagged "is it on?" and you get a reminder the evening before.'),
    h('ul', { class: 'cal-days' }, ctx.db.holidays.map((hd, i) => h('li', { class: hd.date < today ? 'past' : '' },
      h('button', { class: 'cal-day', onclick: () => editHoliday(ctx, i) },
        h('span', { class: 'cal-when' }, fmtDate(hd.date)),
        h('span', { class: 'cal-what' }, hd.name),
        h('span', { class: 'cal-type' }, 'Holiday'))))),
  ];
}

function familySection(ctx) {
  const today = ctx.today();
  return [
    h('div', { class: 'section-head' }, h('h2', null, 'Family'), addBtn('Add', () => editMember(ctx, null))),
    ctx.db.members.map((m) => listRow([
      h('div', { class: 'lrow-title' }, h('span', { class: 'dot', style: { background: m.color || '#94a3b8' } }), m.name, h('span', { class: 'badge badge-muted' }, m.role)),
      m.dob ? h('div', { class: 'lrow-sub' }, `Born ${fmtDateMedium(m.dob)}${m.school?.grade ? ` · ${m.school.grade}` : ''}`) : null,
    ], editBtn(() => editMember(ctx, m.id)))),
    h('p', { class: 'muted small' }, `Ages and birthdays update on their own. Today is ${fmtDateMedium(today)}.`),
  ];
}

function alertsSection(ctx) {
  const st = ctx.db.settings;
  const heads = input({ type: 'number', min: '0', step: '1', value: st.alerts.headsUpMin, class: 'num' });
  const evening = input({ type: 'time', value: st.alerts.eveningReminder || '19:00' });
  const buffer = input({ type: 'number', min: '0', step: '1', value: st.commute.bufferMin, class: 'num' });
  const gap = input({ type: 'number', min: '0', step: '5', value: st.commute.chainGapMin, class: 'num' });
  const base = input({ type: 'number', min: '1', step: '0.05', value: st.commute.baseFactor, class: 'num' });
  const def = input({ type: 'number', min: '1', step: '1', value: st.commute.defaultDriveMin, class: 'num' });
  const traffic = (st.commute.traffic || []).map((t) => ({ ...t }));
  const tWrap = h('div', { class: 'traffic' });
  const renderTraffic = () => {
    clear(tWrap);
    traffic.forEach((t, i) => {
      const days = chips(DAY_OPTIONS, t.days);
      const from = input({ type: 'time', value: t.from });
      const to = input({ type: 'time', value: t.to });
      const f = input({ type: 'number', min: '1', step: '0.05', value: t.factor, class: 'num' });
      t._get = () => ({ label: t.label || 'Traffic', days: days.get(), from: from.value, to: to.value, factor: Number(f.value) || 1 });
      tWrap.append(h('div', { class: 'traffic-row' }, h('strong', null, t.label || 'Traffic'), days.el, h('div', { class: 'row3 tight' }, from, to, f), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove', onclick: () => { traffic.splice(i, 1); renderTraffic(); } }, icon('trash'))));
    });
    tWrap.append(h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => { traffic.push({ label: 'Busy time', days: ['MO', 'TU', 'WE', 'TH', 'FR'], from: '16:00', to: '18:00', factor: 1.3 }); renderTraffic(); } }, icon('plus'), 'Add a busy time'));
  };
  renderTraffic();
  const notif = notificationsSupported() ? Notification.permission : 'unsupported';
  const deviceName = input({ value: ctx.store.deviceName });
  return [
    h('div', { class: 'section-head' }, h('h2', null, 'Alerts & commute')),
    h('div', { class: 'form' },
      h('div', { class: 'row2' }, field('Heads-up before leaving (min)', heads), field('Evening reminder for unsure items', evening)),
      h('div', { class: 'row3' }, field('Default buffer (min)', buffer), field('Chain runs within (min)', gap, 'Back-to-back runs leave from the previous stop.'), field('Unknown drive (min)', def)),
      field('Traffic padding: normal times', base, '1.10 = add 10% to road-route times.'),
      field('Busy times (days, from, to, padding)', tWrap),
      h('div', { class: 'section-actions' }, h('button', { class: 'btn btn-primary', onclick: () => save(ctx, (d) => {
        d.settings.alerts.headsUpMin = numOrNull(heads.value) ?? 10;
        d.settings.alerts.eveningReminder = isHM(evening.value) ? evening.value : '19:00';
        d.settings.commute.bufferMin = numOrNull(buffer.value) ?? 5;
        d.settings.commute.chainGapMin = numOrNull(gap.value) ?? 45;
        d.settings.commute.baseFactor = numOrNull(base.value) ?? 1.1;
        d.settings.commute.defaultDriveMin = numOrNull(def.value) ?? 20;
        d.settings.commute.traffic = traffic.map((t) => t._get());
      }, 'Alert & commute settings', 'Settings saved') }, 'Save settings'))),
    h('div', { class: 'section-head' }, h('h2', null, 'This device')),
    h('div', { class: 'form' },
      field('Device name (shows in the change history)', deviceName),
      h('div', { class: 'section-actions' },
        h('button', { class: 'btn', onclick: () => { ctx.store.setDeviceName(deviceName.value.trim()); toast('Device name saved', { kind: 'ok' }); } }, 'Save name'),
        notif === 'granted' ? h('span', { class: 'badge badge-ok' }, 'Notifications on') : notif === 'unsupported' ? h('span', { class: 'badge badge-muted' }, 'Notifications not available here') : h('button', { class: 'btn', onclick: async () => { const r = await requestNotifications(); toast(r === 'granted' ? 'Notifications on' : 'Notifications not allowed', { kind: r === 'granted' ? 'ok' : 'warn' }); ctx.rerender(); } }, icon('bell'), 'Allow notifications'),
        h('button', { class: 'btn btn-ghost', onclick: () => ctx.testAlert() }, 'Test alert')),
      h('p', { class: 'muted small' }, 'Popups and notifications work while the app is open. For alerts when it is closed, subscribe to the calendar feed on each phone.')),
  ];
}

function feedSection(ctx) {
  const store = ctx.store;
  const info = store.feedInfo();
  const f = ctx.db.settings.feed;
  const out = [h('div', { class: 'section-head' }, h('h2', null, 'Calendar feed (alerts when the app is closed)'))];
  if (store.mode !== 'github') {
    out.push(h('p', null, 'The calendar feed needs the GitHub connection (Data & sync). It lives in a secret gist that your calendar app checks every few minutes.'));
    return out;
  }
  if (!info) {
    out.push(
      h('p', null, 'Creates a secret gist with every run and its "leave by" alarms. Subscribe once on each iPhone, iPad and Mac, and Calendar alerts you even when this app is closed.'),
      h('p', { class: 'muted small' }, 'Needs a token with Gists: read and write. Anyone with the link can read the schedule, so keep it private.'),
      h('button', { class: 'btn btn-primary', onclick: async (e) => { e.currentTarget.disabled = true; try { await store.publishFeed({ create: true }); toast('Calendar feed created', { kind: 'ok' }); } catch (err) { toast(`Feed not created: ${err.message}`, { kind: 'error', ms: 8000 }); } finally { ctx.rerender(); } } }, icon('calendar'), 'Create my private calendar feed'));
    return out;
  }
  const at = store.feedStatus?.at || store.feedPublishedAt;
  out.push(
    h('div', { class: 'feed-box' },
      h('a', { class: 'btn btn-primary', href: info.webcal }, icon('calendar'), 'Subscribe on this device'),
      h('button', { class: 'btn', onclick: async () => { await copyText(info.https); toast('Link copied', { kind: 'ok' }); } }, icon('copy'), 'Copy link'),
      h('button', { class: 'btn btn-ghost', onclick: async (e) => { e.currentTarget.disabled = true; try { await store.publishFeed(); toast('Feed updated', { kind: 'ok' }); } catch (err) { toast(`Not updated: ${err.message}`, { kind: 'error' }); } finally { ctx.rerender(); } } }, icon('refresh'), 'Publish now')),
    h('p', { class: 'muted small' }, at ? `Last published ${new Date(at).toLocaleString()}${store.feedStatus && !store.feedStatus.ok ? ` (last attempt failed: ${store.feedStatus.error})` : ''}.` : 'Publishes automatically after every change.', ` Covers ${f.daysBack} days back and ${f.daysAhead} days ahead.`),
    h('h3', null, 'iPhone / iPad'),
    h('ol', { class: 'steps' },
      h('li', null, 'Tap "Subscribe on this device" (or paste the link in Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add Subscribed Calendar).'),
      h('li', null, h('strong', null, 'Turn OFF "Remove Alarms"'), ' before tapping Save. Otherwise the leave-by alerts are stripped.'),
      h('li', null, 'Check Settings → Notifications → Calendar is allowed.')),
    h('h3', null, 'Mac'),
    h('ol', { class: 'steps' },
      h('li', null, 'Calendar → File → New Calendar Subscription… and paste the link.'),
      h('li', null, 'Uncheck "Remove: Alerts", set Auto-refresh to every 5 or 15 minutes. Choose Location: iCloud to share it with your iPhone automatically.')),
    h('p', { class: 'muted small' }, 'Keep this link private: anyone who has it can read the schedule. Changing the gist ID in db.json makes a new link.'));
  return out;
}

function connectForm(ctx, { compact = false } = {}) {
  const c = ctx.store.config || {};
  // On GitHub Pages the site's own host names the owner (owner.github.io).
  const pagesOwner = /\.github\.io$/.test(location.hostname) ? location.hostname.split('.')[0] : '';
  const owner = input({ value: c.owner || pagesOwner, placeholder: 'your GitHub username', autocapitalize: 'off', autocomplete: 'off' });
  const repo = input({ value: c.repo || 'family-timetable-data', autocapitalize: 'off', autocomplete: 'off' });
  const branch = input({ value: c.branch || 'main', autocapitalize: 'off' });
  const path = input({ value: c.path || 'db.json', autocapitalize: 'off' });
  const token = input({ type: 'password', value: c.token || '', placeholder: 'github_pat_…', autocomplete: 'off' });
  const code = input({ placeholder: 'Setup code (ftm1.…)', autocomplete: 'off' });
  const err = h('div', { class: 'form-error', hidden: true });
  const connect = async (cfg) => {
    formError(err, null);
    try {
      await ctx.store.connect(cfg);
      toast(ctx.store.status === 'missing' ? 'Connected. db.json is not there yet.' : 'Connected', { kind: 'ok' });
      ctx.go('#/today');
    } catch (e) {
      formError(err, [e.message]);
    }
  };
  return h('div', { class: 'form' },
    h('div', { class: 'row2 stack-sm' }, field('GitHub owner', owner), field('Private repo', repo)),
    compact ? null : h('div', { class: 'row2' }, field('Branch', branch), field('File', path)),
    field('Token', token, 'Fine-grained token for this repo only: Contents read & write (read-only for a kids\' iPad). Add Gists read & write for the calendar feed. Stored only on this device.'),
    h('div', { class: 'section-actions' },
      h('button', { class: 'btn btn-primary', onclick: () => connect({ owner: owner.value, repo: repo.value, branch: branch.value || 'main', path: path.value || 'db.json', token: token.value }) }, icon('cloud'), 'Connect')),
    h('div', { class: 'row-locate' }, code, h('button', { class: 'btn', onclick: () => { const cfg = Store.parseSetupCode(code.value); if (!cfg) { formError(err, ['That setup code is not valid.']); return; } if (!cfg.token) { owner.value = cfg.owner; repo.value = cfg.repo; branch.value = cfg.branch; path.value = cfg.path; formError(err, ['That code has no token. Paste a token above, then Connect.']); return; } connect(cfg); } }, 'Use code')),
    err);
}

function importFile(ctx, { create = false } = {}) {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const db = normalizeDb(JSON.parse(await file.text()));
      const { errors } = validateDb(db);
      if (errors.length) throw new ValidationError(errors);
      if (ctx.store.mode === 'github' && (create || ctx.store.status === 'missing')) {
        await ctx.store.createRemote(db, 'Import timetable db');
      } else if (ctx.store.mode === 'github') {
        if (!(await confirmDialog('Replace the timetable?', `Everything in ${ctx.store.config.repo}/${ctx.store.config.path} is replaced by ${file.name}. (The old version stays in the repo history.)`, { confirmLabel: 'Replace' }))) return;
        await ctx.store.mutate(() => db, `Import ${file.name}`);
      } else {
        ctx.store.useLocal(db);
      }
      toast(`Loaded ${file.name}`, { kind: 'ok' });
      ctx.go('#/today');
    } catch (e) {
      toast(`Could not load ${file.name}: ${errText(e)}`, { kind: 'error', ms: 8000 });
    } finally {
      fileInput.remove();
    }
  });
  document.body.append(fileInput);
  fileInput.click();
}

function dataSection(ctx) {
  const store = ctx.store;
  const out = [h('div', { class: 'section-head' }, h('h2', null, 'Data & sync'))];
  if (store.mode === 'github') {
    const c = store.config;
    out.push(
      listRow([
        h('div', { class: 'lrow-title' }, `${c.owner}/${c.repo}`, h('span', { class: `badge ${store.status === 'synced' ? 'badge-ok' : store.status === 'error' ? 'badge-danger' : 'badge-muted'}` }, store.status)),
        h('div', { class: 'lrow-sub' }, `${c.path} on ${c.branch}${store.lastSync ? ` · synced ${new Date(store.lastSync).toLocaleString()}` : ''}`),
        store.error ? h('div', { class: 'lrow-sub error-text' }, store.error) : null,
        ctx.db?.meta?.updatedAt ? h('div', { class: 'lrow-sub' }, `Last change ${new Date(ctx.db.meta.updatedAt).toLocaleString()} from ${ctx.db.meta.updatedBy || '?'}`) : null,
      ], [h('button', { class: 'btn btn-small', onclick: () => store.refresh() }, icon('refresh'), 'Sync now'), h('a', { class: 'btn btn-small btn-ghost', href: `https://github.com/${c.owner}/${c.repo}/commits/${c.branch}/${c.path}`, target: '_blank', rel: 'noopener' }, 'History')]),
      h('h3', null, 'Set up another device'),
      h('p', { class: 'muted small' }, 'Copy a setup code here, send it to yourself (AirDrop, Messages), then paste it on the other device under Manage → Data & sync. iPhone home-screen apps keep their own storage, so paste it inside the installed app.'),
      h('div', { class: 'section-actions' },
        h('button', { class: 'btn', onclick: async () => { await copyText(store.setupCode(true)); toast('Setup code copied (includes the token)', { kind: 'ok' }); } }, icon('copy'), 'Copy setup code'),
        h('button', { class: 'btn btn-ghost', onclick: async () => { await copyText(store.setupCode(false)); toast('Copied without the token', { kind: 'ok' }); } }, 'Copy without token')),
      h('details', { class: 'past' }, h('summary', null, 'Change repo or token'), connectForm(ctx)));
  } else if (store.mode === 'local') {
    out.push(h('p', null, 'This timetable lives only in this browser. Connect GitHub to sync it across devices and turn on the calendar feed.'), connectForm(ctx));
  }
  out.push(
    h('h3', null, 'JSON'),
    h('div', { class: 'section-actions' },
      h('button', { class: 'btn', onclick: () => download(`family-timetable-${ctx.today()}.json`, `${JSON.stringify(ctx.db, null, 2)}\n`) }, 'Export db.json'),
      h('button', { class: 'btn', onclick: () => importFile(ctx) }, 'Import db.json'),
      h('button', { class: 'btn btn-ghost', onclick: () => rawEditor(ctx) }, 'Edit raw JSON')),
    h('h3', null, 'Danger zone'),
    h('div', { class: 'section-actions' }, h('button', { class: 'btn btn-danger', onclick: async () => { if (await confirmDialog('Forget this device?', 'Removes the token and cached timetable from this device only. Nothing in GitHub changes.', { confirmLabel: 'Forget', danger: true })) { store.disconnect(); ctx.go('#/today'); } } }, 'Forget this device')));
  return out;
}

function rawEditor(ctx) {
  const ta = textarea(JSON.stringify(ctx.db, null, 2), { rows: 24, class: 'code', spellcheck: 'false' });
  const err = h('div', { class: 'form-error', hidden: true });
  openModal({
    title: 'Edit raw JSON',
    wide: true,
    body: h('div', { class: 'form' }, h('p', { class: 'muted small' }, 'Every field is described in the app README. The old version stays in the repo history.'), ta, err),
    actions: [
      { label: 'Cancel', ghost: true },
      { label: 'Check', ghost: true, onClick: () => { try { const { errors, warnings } = validateDb(normalizeDb(JSON.parse(ta.value))); formError(err, errors.length ? errors : null); toast(errors.length ? `${errors.length} problem(s)` : `Looks good${warnings.length ? ` (${warnings.length} note${warnings.length === 1 ? '' : 's'})` : ''}`, { kind: errors.length ? 'error' : 'ok' }); } catch (e) { formError(err, [`Not valid JSON: ${e.message}`]); } return true; } },
      { label: 'Save', primary: true, onClick: async () => {
        let next;
        try { next = normalizeDb(JSON.parse(ta.value)); } catch (e) { formError(err, [`Not valid JSON: ${e.message}`]); return true; }
        const { errors } = validateDb(next);
        if (errors.length) { formError(err, errors); return true; }
        return !(await save(ctx, () => next, 'Edit raw JSON', 'Saved'));
      } },
    ],
  });
}

export function renderManage(ctx, section = 'schedules') {
  const cur = SECTIONS.some(([id]) => id === section) ? section : 'schedules';
  const body = {
    schedules: schedulesSection,
    events: eventsSection,
    changes: changesSection,
    places: placesSection,
    calendars: calendarsSection,
    family: familySection,
    alerts: alertsSection,
    feed: feedSection,
    data: dataSection,
  }[cur](ctx);
  return h('div', { class: 'view view-manage' },
    h('nav', { class: 'subnav', 'aria-label': 'Manage sections' }, SECTIONS.map(([id, label]) => h('a', { href: `#/manage/${id}`, class: `subnav-item ${id === cur ? 'active' : ''}` }, label))),
    h('div', { class: 'manage-body' }, body));
}

// ---- first run ---------------------------------------------------------------------

export function renderWelcome(ctx) {
  const store = ctx.store;
  if (store.mode === 'github' && store.status === 'missing') {
    return h('div', { class: 'view view-welcome' },
      h('div', { class: 'welcome-card' },
        h('h1', null, 'Almost there'),
        h('p', null, `Connected to ${store.config.owner}/${store.config.repo}, but there is no ${store.config.path} yet.`),
        h('div', { class: 'section-actions' },
          h('button', { class: 'btn btn-primary', onclick: () => importFile(ctx, { create: true }) }, 'Upload db.json'),
          h('button', { class: 'btn', onclick: async () => { try { await store.createRemote(emptyDb(), 'Start a blank timetable'); ctx.go('#/manage/family'); } catch (e) { toast(errText(e), { kind: 'error' }); } } }, 'Start blank'),
          h('button', { class: 'btn btn-ghost', onclick: () => { store.disconnect(); ctx.rerender(); } }, 'Use a different repo'))));
  }
  if (store.mode === 'github' && !store.db) {
    return h('div', { class: 'view view-welcome' },
      h('div', { class: 'welcome-card' },
        h('h1', null, store.status === 'loading' ? 'Loading…' : 'Could not load the timetable'),
        store.error ? h('p', { class: 'error-text' }, store.error) : null,
        h('div', { class: 'section-actions' }, h('button', { class: 'btn btn-primary', onclick: () => store.refresh() }, icon('refresh'), 'Try again')),
        h('details', { class: 'past' }, h('summary', null, 'Change repo or token'), connectForm(ctx))));
  }
  return h('div', { class: 'view view-welcome' },
    h('div', { class: 'welcome-card' },
      h('div', { class: 'welcome-logo' }, h('img', { src: 'icons/icon-192.png', alt: '', width: '72', height: '72' })),
      h('h1', null, 'Family Timetable'),
      h('p', null, 'School runs, activities and school calendars in one place, with leave-by alerts that account for the drive.'),
      h('h2', null, 'Connect your private data repo'),
      connectForm(ctx, { compact: true }),
      h('h2', null, 'Or try it on this device'),
      h('div', { class: 'section-actions' },
        h('button', { class: 'btn', onclick: () => importFile(ctx) }, 'Open a db.json file'),
        h('button', { class: 'btn btn-ghost', onclick: () => { store.useLocal(emptyDb()); ctx.go('#/manage/family'); } }, 'Start blank'))));
}
