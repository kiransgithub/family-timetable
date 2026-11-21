// Free, key-less geocoding (OpenStreetMap Nominatim) and road routing
// (OSRM demo server), called from the browser and cached in db.json so
// each address is looked up once.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastGeocode = 0;

// Suite numbers confuse the geocoder; drop them.
export function cleanAddress(a) {
  return String(a || '')
    .replace(/\b(ste|suite|unit|apt|bldg|building)\.?\s*[\w-]+/gi, '')
    .replace(/#\s*[\w-]+/g, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function parseLatLng(s) {
  const m = String(s || '').match(/(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export async function geocode(address) {
  const wait = 1100 - (Date.now() - lastGeocode); // Nominatim allows 1 request/second
  if (wait > 0) await sleep(wait);
  lastGeocode = Date.now();
  const q = cleanAddress(address);
  const url = `${NOMINATIM}?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Address lookup failed (HTTP ${res.status}).`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;
  return { lat: Math.round(Number(list[0].lat) * 1e6) / 1e6, lng: Math.round(Number(list[0].lon) * 1e6) / 1e6, label: list[0].display_name };
}

export async function roadRoute(a, b) {
  const url = `${OSRM}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&alternatives=false&steps=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Route lookup failed (HTTP ${res.status}).`);
  const j = await res.json();
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error('No driving route found.');
  return { min: Math.round((j.routes[0].duration / 60) * 10) / 10, km: Math.round(j.routes[0].distance / 100) / 10 };
}

const isApple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

const where = (p) => (Number.isFinite(p?.lat) && Number.isFinite(p?.lng) ? `${p.lat},${p.lng}` : p?.address || p?.name || '');

// Directions with live traffic, in Apple Maps on Apple devices, otherwise Google Maps.
export function directionsUrl(from, to) {
  const dest = to?.address || where(to);
  const origin = from ? where(from) : '';
  if (isApple()) {
    const q = new URLSearchParams({ daddr: dest, dirflg: 'd' });
    if (origin) q.set('saddr', origin);
    return `https://maps.apple.com/?${q}`;
  }
  const q = new URLSearchParams({ api: '1', destination: dest, travelmode: 'driving' });
  if (origin) q.set('origin', origin);
  return `https://www.google.com/maps/dir/?${q}`;
}
