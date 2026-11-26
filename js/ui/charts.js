// Small, dependency-free charts for the Rewards tab: ranked bars, monthly
// columns and a balance line. Series colors come from CSS variables
// (--series-1 rewards / blue, --series-2 deductions / orange); every value
// is also printed or available in a table, and tooltips work on hover and
// keyboard focus. All text goes in via textContent.

import { h } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// ---- shared tooltip ------------------------------------------------------------------

let tip = null;
function tooltip() {
  if (!tip) {
    tip = h('div', { class: 'viz-tip', role: 'tooltip', hidden: true });
    document.body.append(tip);
    window.addEventListener('hashchange', hideTip);
    window.addEventListener('scroll', hideTip, { passive: true });
  }
  return tip;
}

function showTip(x, y, rows) {
  const t = tooltip();
  while (t.firstChild) t.removeChild(t.firstChild);
  for (const r of rows) {
    t.append(h('div', { class: 'viz-tip-row' }, r.key ? h('span', { class: `viz-key viz-key-${r.key}` }) : null, h('strong', null, r.value), r.label ? h('span', { class: 'viz-tip-label' }, r.label) : null));
  }
  t.hidden = false;
  const pad = 12;
  const w = t.offsetWidth;
  const hgt = t.offsetHeight;
  let left = x + pad;
  let top = y - hgt - pad;
  if (left + w > window.innerWidth - 8) left = x - w - pad;
  if (top < 8) top = y + pad;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${top}px`;
}

export function hideTip() {
  if (tip) tip.hidden = true;
}

function hover(el, rowsFn) {
  el.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, rowsFn()));
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect();
    showTip(r.left + r.width / 2, r.top, rowsFn());
  });
  el.addEventListener('blur', hideTip);
}

// ---- ranked horizontal bars (one hue) ------------------------------------------------------

export function rankedBars(items, { series = 1, fmtValue, fmtTip, empty = 'Nothing yet.' }) {
  if (!items.length) return h('p', { class: 'muted small' }, empty);
  const max = Math.max(...items.map((i) => i.points), 1);
  return h('ul', { class: 'rbars', role: 'list' }, items.map((it) => {
    // Bar length is linear in the value; the track keeps room for the label at the tip.
    const bar = h('div', { class: 'rbar-track' }, h('span', { class: `rbar rbar-${series}`, style: { '--p': String(it.points / max) } }), h('span', { class: 'rbar-value' }, fmtValue(it)));
    const li = h('li', { class: 'rbar-row', tabindex: '0', 'aria-label': `${it.label}: ${fmtValue(it)}` },
      h('span', { class: 'rbar-label' }, `${it.emoji ? `${it.emoji} ` : ''}${it.label}`),
      bar);
    hover(li, () => [{ key: series, value: fmtValue(it), label: fmtTip ? fmtTip(it) : it.label }]);
    return li;
  }));
}

// ---- helpers -------------------------------------------------------------------------------------

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Rounded data-end (top), square at the baseline.
function columnPath(x, y, w, hgt) {
  const r = Math.min(4, w / 2, hgt);
  if (hgt <= 0) return '';
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}

function legend(items) {
  return h('div', { class: 'viz-legend' }, items.map((i) => h('span', { class: 'viz-legend-item' }, h('span', { class: `viz-swatch viz-${i.shape || 'rect'} viz-key-${i.key}` }), i.label)));
}

// ---- monthly grouped columns: rewards vs deductions ---------------------------------------------

export function monthColumns(months, { fmtAxis, fmtValue, fmtMonth, width = 600, labels = ['Rewards', 'Deductions'] }) {
  const W = Math.round(width);
  const H = 220;
  const m = { l: 44, r: 8, t: 10, b: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const top = niceMax(Math.max(...months.flatMap((x) => [x.earned, x.deducted]), 1));
  const y = (v) => m.t + ih - (v / top) * ih;
  const band = iw / months.length;
  const bw = Math.min(24, band * 0.3);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz-svg', role: 'img', 'aria-label': `${labels[0]} and ${labels[1].toLowerCase()} by month` });
  for (const t of [0, top / 2, top]) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'viz-axis' : 'viz-grid' }));
    svg.append(s('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'viz-tick' }, fmtAxis(t)));
  }
  months.forEach((mo, i) => {
    const cx = m.l + band * i + band / 2;
    svg.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: 'viz-tick' }, fmtMonth(mo.ym)));
    const pair = [['earned', 1, labels[0]], ['deducted', 2, labels[1]]];
    pair.forEach(([key, series, label], j) => {
      const v = mo[key];
      const x = cx - bw - 1 + j * (bw + 2); // 2px surface gap between the pair
      const g = s('g', { class: 'viz-hit', tabindex: '0', role: 'img', 'aria-label': `${fmtMonth(mo.ym)} ${label}: ${fmtValue(v)}` });
      g.append(s('rect', { x: x - 3, y: m.t, width: bw + 6, height: ih, fill: 'transparent' }));
      if (v > 0) g.append(s('path', { d: columnPath(x, y(v), bw, ih + m.t - y(v)), class: `viz-fill-${series}` }));
      hover(g, () => [{ key: series, value: fmtValue(v), label: `${label} · ${fmtMonth(mo.ym, true)}` }]);
      svg.append(g);
    });
  });
  return h('div', { class: 'viz' }, legend([{ key: 1, label: labels[0] }, { key: 2, label: labels[1] }]), svg);
}

// ---- balance over time (single series line + soft area) --------------------------------------------

export function balanceLine(months, { fmtAxis, fmtValue, fmtMonth, width = 600 }) {
  const W = Math.round(width);
  const H = 190;
  const m = { l: 44, r: 54, t: 12, b: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const top = niceMax(Math.max(...months.map((x) => x.balance), 1));
  const x = (i) => m.l + (months.length === 1 ? iw / 2 : (i / (months.length - 1)) * iw);
  const y = (v) => m.t + ih - (Math.max(0, v) / top) * ih;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz-svg', role: 'img', 'aria-label': 'Balance at the end of each month' });
  for (const t of [0, top / 2, top]) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'viz-axis' : 'viz-grid' }));
    svg.append(s('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'viz-tick' }, fmtAxis(t)));
  }
  months.forEach((mo, i) => svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'viz-tick' }, fmtMonth(mo.ym))));
  const pts = months.map((mo, i) => [x(i), y(mo.balance)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join('');
  svg.append(s('path', { d: `${line}L${pts.at(-1)[0]},${y(0)}L${pts[0][0]},${y(0)}Z`, class: 'viz-area-1' }));
  svg.append(s('path', { d: line, class: 'viz-line-1' }));
  const last = pts.at(-1);
  svg.append(s('circle', { cx: last[0], cy: last[1], r: 4, class: 'viz-dot-1' }));
  svg.append(s('text', { x: last[0] + 8, y: last[1] + 4, class: 'viz-end-label' }, fmtValue(months.at(-1).balance)));
  // Crosshair: snap to the nearest month.
  const cross = s('line', { x1: 0, x2: 0, y1: m.t, y2: m.t + ih, class: 'viz-cross', visibility: 'hidden' });
  const ring = s('circle', { r: 4, class: 'viz-dot-1', visibility: 'hidden' });
  svg.append(cross, ring);
  const hit = s('rect', { x: m.l - 10, y: m.t, width: iw + 20, height: ih, fill: 'transparent', class: 'viz-hit', tabindex: '0', 'aria-label': 'Balance by month: use the table view for every value' });
  const at = (i) => {
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    ring.setAttribute('cx', x(i));
    ring.setAttribute('cy', y(months[i].balance));
    ring.setAttribute('visibility', 'visible');
  };
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    months.forEach((_, i) => { if (Math.abs(x(i) - vx) < Math.abs(x(best) - vx)) best = i; });
    at(best);
    showTip(e.clientX, e.clientY, [{ key: 1, value: fmtValue(months[best].balance), label: `Balance · end of ${fmtMonth(months[best].ym, true)}` }]);
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    ring.setAttribute('visibility', 'hidden');
    hideTip();
  });
  svg.append(hit);
  return h('div', { class: 'viz' }, svg);
}

// The table twin of the monthly charts.
export function monthTable(months, { fmtValue, fmtMonth }) {
  return h('table', { class: 'viz-table' },
    h('thead', null, h('tr', null, h('th', null, 'Month'), h('th', null, 'Rewards'), h('th', null, 'Deductions'), h('th', null, 'Balance at month end'))),
    h('tbody', null, months.map((mo) => h('tr', null, h('td', null, fmtMonth(mo.ym, true)), h('td', null, fmtValue(mo.earned)), h('td', null, fmtValue(mo.deducted)), h('td', null, fmtValue(mo.balance))))));
}
