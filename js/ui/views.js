// Read-only views: Today, Week, Month and Kids.

import { h, icon } from './dom.js';
import { addDays, addMonths, ageOn, daysInMonth, DOW, DOW_SHORT, fmt12, fmtDate, fmtDateLong, fmtMonth, fmtRange, hmToMin, isHM, nextBirthday, startOfWeek, WEEKDAYS } from '../core/time.js';
import { forMember } from '../core/expand.js';
import { describeSource, hasCoords } from '../core/commute.js';
import { HOME_ID, kidsOf, placeLabel } from '../core/model.js';
import { directionsUrl } from '../services/geo.js';

// ---- small pieces -----------------------------------------------------------

export function fmtDays(days = []) {
  const set = new Set(days);
  if (set.size === 7) return 'Every day';
  if (set.size === 5 && WEEKDAYS.every((d) => set.has(d))) return 'Mon–Fri';
  if (set.size === 2 && set.has('SA') && set.has('SU')) return 'Weekends';
  return DOW.filter((d) => set.has(d)).map((d) => DOW_SHORT[d]).join(', ');
}

function memberColor(ctx, id) {
  return ctx.db.members.find((m) => m.id === id)?.color || '#64748b';
}

function whoChips(ctx, ids) {
  if (!ids?.length) return null;
  return h('span', { class: 'who' }, ids.map((id) => {
    const m = ctx.db.members.find((x) => x.id === id);
    return h('span', { class: 'who-chip' }, h('span', { class: 'dot', style: { background: m?.color || '#64748b' } }), m?.name || id);
  }));
}

function stripe(ctx, ids) {
  const colors = (ids || []).map((id) => memberColor(ctx, id));
  if (!colors.length) return '#94a3b8';
  if (colors.length === 1) return colors[0];
  const step = 100 / colors.length;
  return `linear-gradient(180deg, ${colors.map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`).join(', ')})`;
}

const badge = (text, kind = 'neutral') => h('span', { class: `badge badge-${kind}` }, text);

function statusBadges(o) {
  const out = [];
  if (o.status === 'cancelled') out.push(badge('Cancelled', 'muted'));
  if (o.status === 'check') out.push(badge(o.holiday ? `${o.holiday}: is it on?` : 'Confirm', 'warn'));
  if (o.status === 'tbd') out.push(badge(o.tbdReason === 'early_release' ? 'Early release: set time' : 'Time TBD', 'warn'));
  if (o.confirmed && o.holiday) out.push(badge(`On for ${o.holiday}`, 'ok'));
  if (o.variantLabel) out.push(badge(o.variantLabel, 'info'));
  if (o.flags.includes('early_release') && o.status !== 'tbd') out.push(badge('Early release', 'warn'));
  if (o.flags.includes('no_school')) out.push(badge('No school today', 'muted'));
  if (o.changed && !o.variantLabel) out.push(badge('Changed', 'info'));
  if (o.trip?.warning === 'tight') out.push(badge('Tight connection', 'danger'));
  if (o.trip?.warning === 'overlap') out.push(badge('Overlaps another run', 'danger'));
  return out;
}

export function markerChip(m, compact = false) {
  let text;
  let kind = 'muted';
  if (m.kind === 'calendar') {
    if (m.type === 'no_school') text = compact ? `${m.short} off` : `${m.short}: no school · ${m.label}`;
    else if (m.type === 'early_release') {
      text = compact ? `${m.short} early` : `${m.short}: early release${isHM(m.dismissal) ? ` at ${fmt12(hmToMin(m.dismissal))}` : ' (time TBD)'} · ${m.label}`;
      kind = 'warn';
    } else text = compact ? `${m.short}: ${m.label}` : `${m.short}: ${m.label}`;
  } else if (m.kind === 'birthday') {
    text = `🎂 ${m.label}`;
    kind = 'party';
  } else if (m.kind === 'holiday') {
    text = compact ? m.label : `Holiday: ${m.label}`;
  } else {
    text = `${m.emoji ? `${m.emoji} ` : ''}${m.label}`;
    kind = 'info';
  }
  return h('span', { class: `marker marker-${kind}`, style: m.kind === 'calendar' && m.type === 'no_school' && m.color ? { '--mc': m.color } : null }, text);
}

export function markersFor(ctx, list = []) {
  const f = ctx.filter;
  if (!f || f === 'all') return list;
  const kid = ctx.db.members.find((m) => m.id === f);
  return list.filter((m) => {
    if (m.kind === 'calendar') return !kid?.school?.calendar || m.calendarId === kid.school.calendar;
    if (m.kind === 'birthday') return m.memberId === f;
    if (m.kind === 'event') return !m.who?.length || m.who.includes(f);
    return true;
  });
}

function tripLine(ctx, o) {
  if (!o.trip) return null;
  const t = o.trip;
  const from = ctx.db.places.find((p) => p.id === t.from);
  const rough = ['estimate', 'unknown', 'no_home'].includes(t.src);
  const parts = [
    h('strong', null, `Leave ${fmt12(t.leaveMin)}`),
    ` from ${placeLabel(from) || 'Home'}`,
    t.driveMin ? ` · ${rough ? '≈' : '~'}${t.driveMin} min drive` : ' · already there',
    t.bufferMin ? ` + ${t.bufferMin} min buffer` : '',
  ];
  return h('div', { class: `occ-trip ${rough ? 'occ-trip-rough' : ''}` }, icon('car'),
    h('span', null, parts, rough ? h('span', { class: 'trip-src' }, ` (${describeSource(t.src)})`) : null));
}

function directionsButton(ctx, o) {
  const to = ctx.db.places.find((p) => p.id === o.placeId);
  if (!to || (!to.address && !hasCoords(to))) return null;
  const from = o.trip ? ctx.db.places.find((p) => p.id === o.trip.from) : null;
  return h('a', { class: 'btn btn-small', href: directionsUrl(from && (from.address || hasCoords(from)) ? from : null, to), target: '_blank', rel: 'noopener' }, icon('pin'), 'Directions');
}

export function occCard(ctx, o, { highlight = false } = {}) {
  const place = ctx.db.places.find((p) => p.id === o.placeId);
  const note = [o.exception?.note].filter(Boolean).join(' · ');
  return h('article', {
    class: `occ occ-${o.status} ${highlight ? 'occ-highlight' : ''}`,
    style: { '--stripe': stripe(ctx, o.who) },
    dataset: { key: o.key },
  },
  h('div', { class: 'occ-time' },
    h('div', { class: 'occ-start' }, o.startMin == null ? 'TBD' : fmt12(o.startMin)),
    o.endMin != null && o.endMin !== o.startMin ? h('div', { class: 'occ-end' }, `to ${fmt12(o.endMin)}`) : null),
  h('div', { class: 'occ-main' },
    h('div', { class: 'occ-title' }, h('span', null, `${o.emoji ? `${o.emoji} ` : ''}${o.title}`), statusBadges(o)),
    h('div', { class: 'occ-meta' }, whoChips(ctx, o.who), place ? h('span', { class: 'occ-place' }, icon('pin'), placeLabel(place)) : null),
    o.status !== 'cancelled' ? tripLine(ctx, o) : null,
    note ? h('div', { class: 'occ-note' }, note) : null),
  h('div', { class: 'occ-actions' },
    o.status !== 'cancelled' ? directionsButton(ctx, o) : null,
    h('button', { class: 'icon-btn', 'aria-label': `Options for ${o.title}`, onclick: () => ctx.openOccMenu(o) }, icon('more'))));
}

function dateNav(ctx, date, base) {
  const today = ctx.today();
  return h('div', { class: 'datenav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous day', onclick: () => ctx.go(`#/${base}/${addDays(date, -1)}`) }, icon('left')),
    h('div', { class: 'datenav-title' }, h('h1', null, date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : fmtDate(date, { weekday: 'long' })), h('span', null, fmtDate(date, { month: 'long', day: 'numeric', year: 'numeric' }))),
    h('button', { class: 'icon-btn', 'aria-label': 'Next day', onclick: () => ctx.go(`#/${base}/${addDays(date, 1)}`) }, icon('right')),
    date !== today ? h('button', { class: 'btn btn-small', onclick: () => ctx.go(`#/${base}/${today}`) }, 'Today') : null);
}

function banner(text, action) {
  return h('div', { class: 'banner' }, icon('alert'), h('span', null, text), action ? h('button', { class: 'btn btn-small', onclick: action.onClick }, action.label) : null);
}

// ---- Today ------------------------------------------------------------------

export function nextUp(ctx) {
  const today = ctx.today();
  const nowMin = ctx.nowMin();
  const list = forMember(ctx.plan(today, addDays(today, 1)), ctx.filter).filter((o) => o.status !== 'cancelled' && o.status !== 'tbd' && o.startMin != null);
  for (const o of list) {
    const leave = o.trip ? o.trip.leaveMin : o.startMin;
    const end = o.endMin ?? o.startMin;
    if (o.date === today && end >= nowMin && (leave >= nowMin - 2 || o.startMin >= nowMin - 1 || (o.startMin <= nowMin && end >= nowMin))) return o;
    if (o.date > today) return o;
  }
  return null;
}

function nextUpCard(ctx, o) {
  const today = ctx.today();
  const nowMin = ctx.nowMin();
  const place = ctx.db.places.find((p) => p.id === o.placeId);
  const leave = o.trip ? o.trip.leaveMin : null;
  let headline;
  let tone = 'calm';
  if (o.date !== today) headline = `Next: tomorrow ${fmt12(leave ?? o.startMin)}`;
  else if (o.startMin <= nowMin && (o.endMin ?? o.startMin) >= nowMin) {
    headline = `Happening now, until ${fmt12(o.endMin)}`;
    tone = 'now';
  } else if (leave != null) {
    const mins = Math.round(leave - nowMin);
    if (mins <= 0) {
      headline = 'Leave now';
      tone = 'urgent';
    } else if (mins < 60) {
      headline = `Leave in ${mins} min`;
      tone = mins <= 15 ? 'soon' : 'calm';
    } else headline = `Leave at ${fmt12(leave)}`;
  } else headline = `Starts at ${fmt12(o.startMin)}`;
  return h('section', { class: `nextup nextup-${tone}` },
    h('div', { class: 'nextup-head' }, icon(leave != null ? 'car' : 'bell'), h('span', { class: 'nextup-headline' }, headline)),
    h('div', { class: 'nextup-what' }, `${o.emoji ? `${o.emoji} ` : ''}${o.title}`),
    h('div', { class: 'nextup-meta' }, whoChips(ctx, o.who), h('span', null, `${fmtRange(o.startMin, o.endMin)}${place ? ` · ${placeLabel(place)}` : ''}`)),
    o.trip ? tripLine(ctx, o) : null,
    h('div', { class: 'nextup-actions' }, directionsButton(ctx, o), h('button', { class: 'btn btn-small btn-ghost', onclick: () => ctx.openOccMenu(o) }, 'Options')));
}

export function renderToday(ctx, date, focusKey) {
  const today = ctx.today();
  const occs = forMember(ctx.plan(date, date), ctx.filter);
  const markers = markersFor(ctx, ctx.markers(date, date).get(date));
  const wrap = h('div', { class: 'view view-today' }, dateNav(ctx, date, 'today'));
  const home = ctx.db.places.find((p) => p.id === HOME_ID);
  if (!hasCoords(home)) wrap.append(banner('Add your home address so leave-by times use real drive times.', { label: 'Set home', onClick: () => ctx.go('#/manage/places') }));
  if (markers.length) wrap.append(h('div', { class: 'markers' }, markers.map((m) => markerChip(m))));
  if (date === today) {
    const nu = nextUp(ctx);
    if (nu) wrap.append(nextUpCard(ctx, nu));
  }
  if (!occs.length) {
    wrap.append(h('div', { class: 'empty' }, h('div', { class: 'empty-emoji' }, '🌤️'), h('p', null, 'Nothing scheduled.'), h('button', { class: 'btn btn-small', onclick: () => ctx.addEvent(date) }, icon('plus'), 'Add something')));
  } else {
    wrap.append(h('div', { class: 'agenda' }, occs.map((o) => occCard(ctx, o, { highlight: o.key === focusKey }))));
    wrap.append(h('div', { class: 'agenda-foot' }, h('button', { class: 'btn btn-small btn-ghost', onclick: () => ctx.addEvent(date) }, icon('plus'), 'Add a one-off')));
  }
  return wrap;
}

// ---- Week -------------------------------------------------------------------

export function renderWeek(ctx, anyDate) {
  const start = startOfWeek(anyDate, ctx.db.settings.display?.weekStartsOn || 'MO');
  const end = addDays(start, 6);
  const today = ctx.today();
  const occs = forMember(ctx.plan(start, end), ctx.filter);
  const markers = ctx.markers(start, end);
  const byDate = new Map();
  for (const o of occs) {
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date).push(o);
  }
  const title = `${fmtDate(start, { month: 'short', day: 'numeric' })} – ${fmtDate(end, { month: start.slice(5, 7) === end.slice(5, 7) ? undefined : 'short', day: 'numeric' })}`;
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(start, i);
    const ms = markersFor(ctx, markers.get(d));
    const items = byDate.get(d) || [];
    days.push(h('section', { class: `wday ${d === today ? 'wday-today' : ''} ${d < today ? 'wday-past' : ''}` },
      h('button', { class: 'wday-head', onclick: () => ctx.go(`#/today/${d}`) }, h('span', { class: 'wday-dow' }, fmtDate(d, { weekday: 'short' })), h('span', { class: 'wday-num' }, fmtDate(d, { day: 'numeric' }))),
      ms.length ? h('div', { class: 'wday-markers' }, ms.map((m) => markerChip(m, true))) : null,
      items.length
        ? h('ul', { class: 'wlist' }, items.map((o) => h('li', null, h('button', {
          class: `witem witem-${o.status}`,
          style: { '--stripe': stripe(ctx, o.who) },
          onclick: () => ctx.go(`#/today/${d}/${encodeURIComponent(o.key)}`),
        },
        h('span', { class: 'witem-time' }, o.startMin == null ? 'TBD' : fmt12(o.startMin)),
        h('span', { class: 'witem-title' }, `${o.emoji ? `${o.emoji} ` : ''}${o.title}`),
        o.trip && o.status !== 'cancelled' ? h('span', { class: 'witem-leave' }, icon('car'), fmt12(o.trip.leaveMin)) : null,
        o.status === 'check' ? h('span', { class: 'witem-flag' }, '?') : null))))
        : h('p', { class: 'wday-empty' }, '—')));
  }
  return h('div', { class: 'view view-week' },
    h('div', { class: 'datenav' },
      h('button', { class: 'icon-btn', 'aria-label': 'Previous week', onclick: () => ctx.go(`#/week/${addDays(start, -7)}`) }, icon('left')),
      h('div', { class: 'datenav-title' }, h('h1', null, title), h('span', null, start <= today && today <= end ? 'This week' : fmtDate(start, { year: 'numeric' }))),
      h('button', { class: 'icon-btn', 'aria-label': 'Next week', onclick: () => ctx.go(`#/week/${addDays(start, 7)}`) }, icon('right')),
      !(start <= today && today <= end) ? h('button', { class: 'btn btn-small', onclick: () => ctx.go(`#/week/${today}`) }, 'This week') : null),
    h('div', { class: 'week-grid' }, days));
}

// ---- Month ------------------------------------------------------------------

export function renderMonth(ctx, ym) {
  const weekStartsOn = ctx.db.settings.display?.weekStartsOn || 'MO';
  const first = `${ym}-01`;
  const gridStart = startOfWeek(first, weekStartsOn);
  const last = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  const weeks = Math.ceil((Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${gridStart}T00:00:00Z`)) / 86400000) + 1) / 7);
  const gridEnd = addDays(gridStart, weeks * 7 - 1);
  const today = ctx.today();
  const occs = forMember(ctx.plan(gridStart, gridEnd), ctx.filter).filter((o) => o.status !== 'cancelled');
  const markers = ctx.markers(gridStart, gridEnd);
  const byDate = new Map();
  for (const o of occs) {
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date).push(o);
  }
  const startIdx = DOW.indexOf(weekStartsOn);
  const head = Array.from({ length: 7 }, (_, i) => h('div', { class: 'mhead' }, DOW_SHORT[DOW[(startIdx + i) % 7]]));
  const cells = [];
  for (let i = 0; i < weeks * 7; i += 1) {
    const d = addDays(gridStart, i);
    const ms = markersFor(ctx, markers.get(d));
    const items = byDate.get(d) || [];
    const off = ms.filter((m) => m.kind === 'calendar' && m.type === 'no_school');
    const early = ms.some((m) => m.kind === 'calendar' && m.type === 'early_release');
    const bday = ms.find((m) => m.kind === 'birthday');
    cells.push(h('button', {
      class: `mcell ${d.slice(0, 7) !== ym ? 'mcell-out' : ''} ${d === today ? 'mcell-today' : ''}`,
      onclick: () => ctx.go(`#/today/${d}`),
      'aria-label': fmtDateLong(d),
    },
    h('div', { class: 'mcell-top' }, h('span', { class: 'mnum' }, Number(d.slice(8))), bday ? h('span', { title: bday.label }, '🎂') : null, ms.some((m) => m.kind === 'holiday') ? h('span', { class: 'mholiday', title: ms.find((m) => m.kind === 'holiday').label }, '★') : null),
    off.length || early ? h('div', { class: 'mbars' }, off.map((m) => h('span', { class: 'mbar', style: { background: m.color || '#94a3b8' }, title: `${m.short}: ${m.label}` })), early ? h('span', { class: 'mbar mbar-early', title: 'Early release' }) : null) : null,
    h('div', { class: 'mitems' },
      items.slice(0, 3).map((o) => h('span', { class: `mitem mitem-${o.status}`, style: { '--stripe': stripe(ctx, o.who) } }, `${o.emoji || '•'} ${o.startMin == null ? '' : fmt12(o.startMin).replace(':00', '').replace(' ', '')}`)),
      items.length > 3 ? h('span', { class: 'mmore' }, `+${items.length - 3}`) : null)));
  }
  const cals = ctx.db.calendars.filter((c) => {
    if (!ctx.filter || ctx.filter === 'all') return true;
    return ctx.db.members.find((m) => m.id === ctx.filter)?.school?.calendar === c.id;
  });
  return h('div', { class: 'view view-month' },
    h('div', { class: 'datenav' },
      h('button', { class: 'icon-btn', 'aria-label': 'Previous month', onclick: () => ctx.go(`#/month/${addMonths(ym, -1)}`) }, icon('left')),
      h('div', { class: 'datenav-title' }, h('h1', null, fmtMonth(ym))),
      h('button', { class: 'icon-btn', 'aria-label': 'Next month', onclick: () => ctx.go(`#/month/${addMonths(ym, 1)}`) }, icon('right')),
      ym !== today.slice(0, 7) ? h('button', { class: 'btn btn-small', onclick: () => ctx.go(`#/month/${today.slice(0, 7)}`) }, 'This month') : null),
    h('div', { class: 'month-grid' }, head, cells),
    h('div', { class: 'legend' },
      cals.map((c) => h('span', { class: 'legend-item' }, h('span', { class: 'mbar', style: { background: c.color || '#94a3b8' } }), `${c.short || c.name} no school`)),
      h('span', { class: 'legend-item' }, h('span', { class: 'mbar mbar-early' }), 'Early release'),
      h('span', { class: 'legend-item' }, '★ Holiday: check activities'),
      h('span', { class: 'legend-item' }, '🎂 Birthday')));
}

// ---- Kids -------------------------------------------------------------------

export function renderKids(ctx) {
  const today = ctx.today();
  const kids = kidsOf(ctx.db).filter((k) => !ctx.filter || ctx.filter === 'all' || k.id === ctx.filter);
  const dowRank = (s) => Math.min(...(s.days || []).map((d) => (DOW.indexOf(d) + 6) % 7));
  return h('div', { class: 'view view-kids' },
    h('div', { class: 'datenav' }, h('div', { class: 'datenav-title' }, h('h1', null, 'Kids'))),
    kids.length ? null : h('div', { class: 'empty' }, h('p', null, 'Add your kids under Manage → Family.')),
    kids.map((k) => {
      const age = k.dob ? ageOn(k.dob, today) : null;
      const bd = k.dob ? nextBirthday(k.dob, today) : null;
      const school = ctx.db.places.find((p) => p.id === k.school?.place);
      const cal = ctx.db.calendars.find((c) => c.id === k.school?.calendar);
      const routine = ctx.db.schedules.filter((s) => !s.archived && (s.who || []).includes(k.id) && (!s.until || s.until >= today))
        .sort((a, b) => dowRank(a) - dowRank(b) || String(a.start || '99').localeCompare(String(b.start || '99')));
      const offDays = (cal?.days || []).filter((d) => (d.end || d.start) >= today).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 5);
      return h('section', { class: 'kid-card', style: { '--kid': k.color || '#64748b' } },
        h('header', { class: 'kid-head' },
          h('div', { class: 'avatar' }, k.name.slice(0, 1)),
          h('div', null,
            h('h2', null, k.name),
            age ? h('p', { class: 'kid-sub' }, `${age.years} years${age.months ? `, ${age.months} month${age.months === 1 ? '' : 's'}` : ''}${k.school?.grade ? ` · ${k.school.grade}` : ''}`) : null,
            bd ? h('p', { class: 'kid-sub' }, bd.inDays === 0 ? `🎂 ${bd.turns} today!` : `🎂 Turns ${bd.turns} on ${fmtDate(bd.date, { weekday: 'short', month: 'short', day: 'numeric' })} (${bd.inDays} day${bd.inDays === 1 ? '' : 's'})`) : null)),
        school ? h('p', { class: 'kid-school' }, icon('pin'), school.name) : null,
        k.notes ? h('p', { class: 'kid-notes' }, k.notes) : null,
        h('h3', null, 'Every week'),
        routine.length ? h('ul', { class: 'routine' }, routine.map((s) => {
          const place = ctx.db.places.find((p) => p.id === s.place);
          const st = isHM(s.start) ? hmToMin(s.start) : null;
          const en = isHM(s.end) ? hmToMin(s.end) : st != null && s.durationMin ? st + s.durationMin : null;
          const time = st != null && !s.tbd ? fmtRange(st, en) : 'Time TBD';
          return h('li', null,
            h('span', { class: 'routine-days' }, fmtDays(s.days)),
            h('span', { class: 'routine-time' }, time),
            h('span', { class: 'routine-what' }, `${s.emoji ? `${s.emoji} ` : ''}${s.title}${place ? ` · ${placeLabel(place)}` : ''}${s.from && s.from > today ? ` (from ${fmtDate(s.from, { month: 'short', day: 'numeric' })})` : ''}`));
        })) : h('p', { class: 'muted' }, 'Nothing recurring yet.'),
        cal ? h('h3', null, `Coming up at ${cal.short || cal.name}`, cal.verify ? h('span', { class: 'badge badge-warn' }, 'verify dates') : null) : null,
        cal ? (offDays.length ? h('ul', { class: 'offdays' }, offDays.map((d) => h('li', null,
          h('span', { class: 'offdays-when' }, d.end && d.end !== d.start ? `${fmtDate(d.start, { month: 'short', day: 'numeric' })} – ${fmtDate(d.end, { month: 'short', day: 'numeric' })}` : fmtDate(d.start)),
          h('span', null, `${d.type === 'early_release' ? '⏰ Early release' : 'No school'} · ${d.label}${d.type === 'early_release' && isHM(d.dismissal) ? ` (${fmt12(hmToMin(d.dismissal))})` : ''}`)))) : h('p', { class: 'muted' }, 'No more days off this school year.')) : null,
        cal?.lastDay && cal.lastDay >= today ? h('p', { class: 'muted' }, `Last day of school: ${fmtDate(cal.lastDay, { weekday: 'short', month: 'short', day: 'numeric' })}`) : null);
    }));
}
