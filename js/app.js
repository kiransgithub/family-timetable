// App shell: routing, header and tabs, sync loop, alert popups and the
// service worker.

import { Store, RewardsStore } from './store.js';
import { h, append, clear, icon, toast, openModal, closeTopModal } from './ui/dom.js';
import { renderToday, renderWeek, renderMonth, renderKids } from './ui/views.js';
import { renderManage, renderWelcome, openOccMenu, editEvent, locateAndRoute } from './ui/manage.js';
import { renderRewards } from './ui/rewards.js';
import { onLockChange } from './services/lock.js';
import { expand, dayMarkers } from './core/expand.js';
import { planTrips, wantedRoutes, hasCoords } from './core/commute.js';
import { kidsOf, makeIndex } from './core/model.js';
import { addDays, addMonths, fmt12, isDate, todayIn, utcToZoned, zonedToUtc } from './core/time.js';
import { directionsUrl } from './services/geo.js';
import { AlertScheduler, chime, showSystemNotification, unlockAudio } from './services/notify.js';

const store = new Store();
const rewards = new RewardsStore(store);
const state = {
  filter: localStorage.getItem('ftm.filter') || 'all',
};

// ?now=2026-11-23T14:20 previews the app at another time (family time zone).
const nowOverride = (() => {
  const m = new URLSearchParams(location.search).get('now')?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const tz = store.db?.meta?.timezone || 'America/Phoenix';
  return { base: zonedToUtc(m[1], Number(m[2]) * 60 + Number(m[3]), tz), loadedAt: Date.now() };
})();
const now = () => (nowOverride ? nowOverride.base + (Date.now() - nowOverride.loadedAt) : Date.now());

// ---- derived data (cached per db version) -------------------------------------

let cache = { db: null, index: null, plans: new Map(), markers: new Map() };
function fresh() {
  if (cache.db !== store.db) cache = { db: store.db, index: store.db ? makeIndex(store.db) : null, plans: new Map(), markers: new Map() };
  return cache;
}
function plan(from, to) {
  const c = fresh();
  const key = `${from}|${to}`;
  if (!c.plans.has(key)) c.plans.set(key, planTrips(store.db, expand(store.db, from, to, c.index), c.index));
  return c.plans.get(key);
}
function markers(from, to) {
  const c = fresh();
  const key = `${from}|${to}`;
  if (!c.markers.has(key)) c.markers.set(key, dayMarkers(store.db, from, to));
  return c.markers.get(key);
}

const tz = () => store.db?.meta?.timezone || 'America/Phoenix';

const ctx = {
  store,
  rewards,
  get db() { return store.db; },
  get filter() { return state.filter; },
  now,
  today: () => todayIn(tz(), now()),
  nowMin: () => utcToZoned(now(), tz()).min,
  plan,
  markers,
  go: (hash) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  },
  rerender: () => render(),
  openOccMenu: (o) => openOccMenu(ctx, o),
  addEvent: (date) => editEvent(ctx, null, { date }),
  testAlert: () => fireAlert({
    id: `test:${Date.now()}`,
    kind: 'leave',
    title: 'Leave now · 🚗 Test alert',
    body: 'This is what a leave-by alert looks like.',
  }),
};

// ---- routing --------------------------------------------------------------------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [name = 'today', a, b] = parts;
  return { name, a, b };
}

const TABS = [
  ['today', 'Today', 'today'],
  ['week', 'Week', 'week'],
  ['month', 'Month', 'month'],
  ['kids', 'Kids', 'kids'],
  ['rewards', 'Rewards', 'rewards'],
  ['manage', 'Manage', 'manage'],
];

function relTime(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(ms).toLocaleDateString();
}

function syncPill() {
  let text;
  let kind;
  if (store.mode === 'local') [text, kind] = ['This device only', 'muted'];
  else if (store.status === 'saving') [text, kind] = ['Saving…', 'busy'];
  else if (store.status === 'loading') [text, kind] = ['Syncing…', 'busy'];
  else if (store.status === 'offline') [text, kind] = ['Offline', 'warn'];
  else if (store.status === 'error') [text, kind] = ['Sync problem', 'danger'];
  else if (store.status === 'synced') [text, kind] = [`Synced ${relTime(store.lastSync)}`, 'ok'];
  else [text, kind] = ['Not connected', 'muted'];
  return h('a', { class: `sync sync-${kind}`, href: '#/manage/data', title: store.error || text }, h('span', { class: 'sync-dot' }), h('span', { class: 'sync-text' }, text));
}

function renderChrome(route, ready) {
  const header = document.getElementById('header');
  clear(header);
  const kids = ready ? kidsOf(store.db) : [];
  append(header, [
    h('div', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/today' }, h('img', { src: 'icons/icon-192.png', alt: '', width: '28', height: '28' }), h('span', null, store.db?.meta?.title || 'Family Timetable')),
      store.mode !== 'none' ? syncPill() : null),
    ready && kids.length > 1 && route.name !== 'manage' && route.name !== 'rewards'
      ? h('div', { class: 'filters', role: 'tablist', 'aria-label': 'Show' },
        [{ id: 'all', name: 'Everyone', color: null }, ...kids].map((k) => h('button', {
          class: `fchip ${state.filter === k.id ? 'fchip-on' : ''}`,
          role: 'tab',
          'aria-selected': state.filter === k.id ? 'true' : 'false',
          style: k.color ? { '--kc': k.color } : null,
          onclick: () => {
            state.filter = k.id;
            localStorage.setItem('ftm.filter', k.id);
            render();
          },
        }, k.color ? h('span', { class: 'dot', style: { background: k.color } }) : null, k.name)))
      : null]);
  const tabs = document.getElementById('tabs');
  clear(tabs);
  tabs.hidden = !ready;
  if (ready) {
    for (const [id, label, ic] of TABS) {
      // Rewards opens straight to the child picked in the filter, if any.
      const href = id === 'rewards' && state.filter !== 'all' && kids.some((k) => k.id === state.filter) ? `#/rewards/${state.filter}` : `#/${id}`;
      tabs.append(h('a', { href, class: `tab ${route.name === id ? 'tab-on' : ''}`, 'aria-current': route.name === id ? 'page' : null }, icon(ic), h('span', null, label)));
    }
  }
}

let lastRouteKey = '';
function render() {
  const route = parseRoute();
  const ready = !!store.db && store.mode !== 'none' && store.status !== 'missing';
  renderChrome(route, ready);
  const view = document.getElementById('view');
  const routeKey = location.hash;
  const keepScroll = routeKey === lastRouteKey ? window.scrollY : 0;
  lastRouteKey = routeKey;
  clear(view);
  let node;
  try {
    if (!ready) node = renderWelcome(ctx);
    else if (route.name === 'week') node = renderWeek(ctx, isDate(route.a) ? route.a : ctx.today());
    else if (route.name === 'month') node = renderMonth(ctx, /^\d{4}-\d{2}$/.test(route.a || '') ? route.a : ctx.today().slice(0, 7));
    else if (route.name === 'kids') node = renderKids(ctx);
    else if (route.name === 'rewards') node = renderRewards(ctx, route.a);
    else if (route.name === 'manage') node = renderManage(ctx, route.a);
    else node = renderToday(ctx, isDate(route.a) ? route.a : ctx.today(), route.b);
  } catch (e) {
    console.error(e);
    node = h('div', { class: 'view' }, h('div', { class: 'banner banner-error' }, icon('alert'), h('span', null, `Something in the data could not be shown: ${e.message}`), h('a', { class: 'btn btn-small', href: '#/manage/data' }, 'Open data')));
  }
  view.append(node);
  window.scrollTo(0, keepScroll);
  if (route.b && route.name === 'today') view.querySelector('.occ-highlight')?.scrollIntoView({ block: 'center' });
}

// Re-render on data changes, but never while someone is typing in a form.
function renderSoon() {
  const a = document.activeElement;
  if (a && document.getElementById('view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  render();
}

// ---- alerts -----------------------------------------------------------------------

const popupQueue = [];
let popupOpen = false;

function showNextPopup() {
  if (popupOpen || !popupQueue.length) return;
  const a = popupQueue.shift();
  popupOpen = true;
  const o = a.occurrence;
  const to = o ? store.db.places.find((p) => p.id === o.placeId) : null;
  const from = o?.trip ? store.db.places.find((p) => p.id === o.trip.from) : null;
  const tone = a.kind === 'leave' ? 'urgent' : a.kind === 'heads' ? 'soon' : 'calm';
  openModal({
    title: a.title,
    body: h('div', { class: `alert-pop alert-${tone}` },
      h('div', { class: 'alert-icon' }, icon(a.kind === 'leave' || a.kind === 'heads' ? 'car' : 'bell')),
      h('p', { class: 'alert-body' }, a.body || ''),
      o?.trip ? h('p', { class: 'muted' }, `Arrive by ${fmt12(o.arriveMin)}. Leave-by assumes ~${o.trip.driveMin} min of driving plus ${o.trip.bufferMin} min to park and walk in.`) : null,
      to && (to.address || hasCoords(to)) ? h('a', { class: 'btn btn-primary', href: directionsUrl(from, to), target: '_blank', rel: 'noopener' }, icon('pin'), 'Directions') : null),
    onClose: () => {
      popupOpen = false;
      setTimeout(showNextPopup, 300);
    },
    actions: [
      ...(a.occurrence ? [{ label: 'Snooze 5 min', ghost: true, onClick: () => { scheduler.snooze(a, 5); toast('Snoozed for 5 minutes'); } }] : []),
      { label: 'Got it', primary: true },
    ],
  });
}

function fireAlert(a) {
  chime();
  showSystemNotification(a);
  popupQueue.push(a);
  showNextPopup();
}

const scheduler = new AlertScheduler({ getDb: () => (store.mode !== 'none' ? store.db : null), now, onFire: fireAlert });

// ---- background jobs ------------------------------------------------------------

let autoLocateTried = false;
async function maybeAutoLocate() {
  if (autoLocateTried || !store.db || !store.canWrite || store.status !== 'synced') return;
  const missingCoords = store.db.places.some((p) => p.address && !hasCoords(p));
  const today = ctx.today();
  const needsRoutes = wantedRoutes(store.db, plan(today, addDays(today, 14))).length > 0;
  if (!missingCoords && !needsRoutes) return;
  autoLocateTried = true;
  try {
    await locateAndRoute(ctx, { quiet: true });
  } catch {
    /* shown as a toast inside */
  }
}

function maybeRepublishFeed() {
  const f = store.db?.settings?.feed;
  if (store.mode !== 'github' || !f?.gistId || !store.canWrite) return;
  if (Date.now() - (store.feedPublishedAt || 0) > 20 * 3600000) store.scheduleFeed(5000); // keep the rolling window fresh
}

let lastRefresh = 0;
async function sync({ quiet = true } = {}) {
  if (store.mode !== 'github') return;
  lastRefresh = Date.now();
  await Promise.all([store.refresh({ quiet }), rewards.refresh({ quiet: quiet && !!rewards.data })]);
  maybeAutoLocate();
  maybeRepublishFeed();
}

// Load rewards.json whenever the device is connected to a different repo
// (first setup, setup code, or switching to local mode).
let rewardsRepo = rewards.repoKey;
function watchRewardsRepo() {
  if (rewards.repoKey === rewardsRepo) return;
  rewardsRepo = rewards.repoKey;
  rewards.refresh();
}

// ---- service worker ------------------------------------------------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => toast('A new version is ready.', { ms: 15000, action: { label: 'Reload', onClick: () => worker.postMessage('skipWaiting') } });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) location.hash = e.data.url.replace(/^.*#/, '#');
  });
}

// ---- start --------------------------------------------------------------------------

async function applySetupFromHash() {
  const m = location.hash.match(/setup=([^&]+)/);
  if (!m) return;
  const cfg = Store.parseSetupCode(decodeURIComponent(m[1]));
  history.replaceState(null, '', `${location.pathname}${location.search}#/today`);
  if (!cfg?.token) return;
  try {
    await store.connect(cfg);
    toast('This device is set up', { kind: 'ok' });
  } catch (e) {
    toast(`Setup code did not work: ${e.message}`, { kind: 'error', ms: 8000 });
  }
}

function keyboard(e) {
  if (e.key === 'Escape') {
    closeTopModal();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || document.body.classList.contains('modal-open')) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const r = parseRoute();
  const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (!step) {
    if (e.key === 't') ctx.go('#/today');
    return;
  }
  const today = ctx.today();
  if (r.name === 'today') ctx.go(`#/today/${addDays(isDate(r.a) ? r.a : today, step)}`);
  else if (r.name === 'week') ctx.go(`#/week/${addDays(isDate(r.a) ? r.a : today, 7 * step)}`);
  else if (r.name === 'month') ctx.go(`#/month/${addMonths(/^\d{4}-\d{2}$/.test(r.a || '') ? r.a : today.slice(0, 7), step)}`);
}

async function start() {
  store.addEventListener('change', renderSoon);
  store.addEventListener('change', watchRewardsRepo);
  rewards.addEventListener('change', renderSoon);
  onLockChange(renderSoon);
  window.addEventListener('hashchange', render);
  document.addEventListener('keydown', keyboard);
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockAudio, { once: true, capture: true }));
  render();
  await applySetupFromHash();
  if (store.mode === 'github') await sync({ quiet: !!store.db });
  else if (store.mode === 'local') {
    store.refresh();
    rewards.refresh();
  }
  render();
  scheduler.start();
  registerServiceWorker();
  // Countdown refresh on Today, and a gentle sync every 5 minutes.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (parseRoute().name === 'today' && !document.body.classList.contains('modal-open')) renderSoon();
    if (Date.now() - lastRefresh > 5 * 60000) sync();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 60000) sync();
  });
  window.addEventListener('online', () => sync());
  // Rewards charts are drawn to fit the screen; redraw after a resize or rotation.
  let resizeTimer = null;
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(window.innerWidth - lastWidth) < 40 || parseRoute().name !== 'rewards') return;
      lastWidth = window.innerWidth;
      renderSoon();
    }, 250);
  });
}

start();
