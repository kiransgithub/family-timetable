// Leave-by times. Each trip starts from home, or from the previous stop
// when the two runs are back-to-back (e.g. preschool pickup -> school
// pickup). Drive minutes come from a manual override, the cached road
// route, or a straight-line estimate, and are padded for rush-hour traffic.

import { dowOf, hmToMin } from './time.js';
import { HOME_ID, makeIndex } from './model.js';

export const routeKey = (a, b) => `${a}>${b}`;
export const hasCoords = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
export const coordKey = (p) => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Straight-line distance -> rough city driving minutes (road detour ~35%,
// ~42 km/h average with lights, +2 min to get rolling).
export const estimateMinutes = (km) => Math.max(1, Math.round(((km * 1.35) / 42) * 60 + 2));

export function cachedRoute(db, fromId, toId, places) {
  const c = db.routes?.cache?.[routeKey(fromId, toId)];
  const a = places.get(fromId);
  const b = places.get(toId);
  if (!c || !hasCoords(a) || !hasCoords(b) || !Number.isFinite(c.min)) return null;
  return c.from === coordKey(a) && c.to === coordKey(b) ? c : null;
}

export function baseDrive(db, fromId, toId, places) {
  if (fromId === toId) return { min: 0, src: 'same' };
  const override = db.routes?.overrides?.[routeKey(fromId, toId)];
  if (Number.isFinite(override)) return { min: override, src: 'manual' };
  const cached = cachedRoute(db, fromId, toId, places);
  if (cached) return { min: cached.min, km: cached.km, src: 'route' };
  const a = places.get(fromId);
  const b = places.get(toId);
  if (hasCoords(a) && hasCoords(b)) {
    const km = haversineKm(a, b);
    return { min: km < 0.25 ? 1 : estimateMinutes(km), km: Math.round(km * 10) / 10, src: 'estimate' };
  }
  return { min: db.settings?.commute?.defaultDriveMin ?? 20, src: 'unknown' };
}

export function trafficFactor(settings, dow, minOfDay) {
  const c = settings?.commute || {};
  let f = Number(c.baseFactor) || 1;
  for (const t of c.traffic || []) {
    if (!t || !Array.isArray(t.days) || !t.days.includes(dow)) continue;
    if (minOfDay >= hmToMin(t.from) && minOfDay < hmToMin(t.to)) f = Math.max(f, Number(t.factor) || 1);
  }
  return f;
}

const isTrip = (o) => !o.allDay && o.travel && o.placeId && o.status !== 'cancelled' && o.status !== 'tbd' && o.arriveMin != null;

function planDay(db, list, places) {
  const c = db.settings?.commute || {};
  const gap = c.chainGapMin ?? 45;
  const items = list.filter(isTrip).sort((a, b) => a.arriveMin - b.arriveMin || (a.startMin ?? 0) - (b.startMin ?? 0));
  let prev = null;
  for (const o of items) {
    let from = HOME_ID;
    let chained = false;
    let warning = null;
    if (o.origin && o.origin !== 'auto') {
      from = o.origin;
    } else if (prev) {
      const prevEnd = prev.endMin ?? prev.arriveMin;
      const slack = o.arriveMin - prevEnd;
      if (slack < 0 && prev.placeId !== o.placeId) warning = 'overlap';
      else if (slack >= 0 && slack <= gap) {
        from = prev.placeId;
        chained = true;
      }
    }
    if (!places.has(from)) from = HOME_ID;
    const base = baseDrive(db, from, o.placeId, places);
    const place = places.get(o.placeId);
    const bufferMin = from === o.placeId ? 0 : Number(place?.bufferMin ?? c.bufferMin ?? 5);
    const factor = base.min > 0 ? trafficFactor(db.settings, dowOf(o.date), o.arriveMin - base.min) : 1;
    const driveMin = Math.ceil(base.min * factor);
    const leaveMin = o.arriveMin - driveMin - bufferMin;
    if (chained && prev && leaveMin < (prev.endMin ?? prev.arriveMin)) warning = 'tight';
    const src = from === HOME_ID && !hasCoords(places.get(HOME_ID)) ? 'no_home' : base.src;
    o.trip = { from, to: o.placeId, chained, baseMin: base.min, km: base.km ?? null, src, factor, driveMin, bufferMin, leaveMin, warning };
    prev = o;
  }
}

// Adds a `trip` to every occurrence that needs a drive. Returns the list.
export function planTrips(db, occs, index = makeIndex(db)) {
  const byDate = new Map();
  for (const o of occs) {
    o.trip = null;
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date).push(o);
  }
  for (const list of byDate.values()) planDay(db, list, index.places);
  return occs;
}

// Route pairs worth fetching from the road router: every place from home,
// plus any chained pair seen in the planned trips.
export function wantedRoutes(db, occs, index = makeIndex(db)) {
  const pairs = new Map();
  const add = (a, b) => {
    if (a === b) return;
    const pa = index.places.get(a);
    const pb = index.places.get(b);
    if (!hasCoords(pa) || !hasCoords(pb)) return;
    if (Number.isFinite(db.routes?.overrides?.[routeKey(a, b)])) return;
    if (cachedRoute(db, a, b, index.places)) return;
    pairs.set(routeKey(a, b), [a, b]);
  };
  for (const p of db.places) if (p.id !== HOME_ID) add(HOME_ID, p.id);
  for (const o of occs) if (o.trip) add(o.trip.from, o.trip.to);
  return [...pairs.values()];
}

export function describeSource(src) {
  return {
    route: 'road route',
    manual: 'your estimate',
    estimate: 'straight-line estimate',
    unknown: 'default guess',
    no_home: 'home address not set',
    same: 'same place',
  }[src] || src;
}
