// Shape of the JSON db, defaults, and small lookup helpers.

export const DB_VERSION = 1;
export const HOME_ID = 'home';

export const DAY_TYPES = {
  no_school: 'No school',
  early_release: 'Early release',
  event: 'School event',
};

export const KINDS = { school: 'School run', activity: 'Activity', other: 'Other' };
export const ALARM_MODES = { both: 'Heads-up + leave now', leave: 'Leave now only', none: 'No alerts' };
export const CAL_MODES = { school_days: 'Only on school days', flag: 'Every week (flag days off)' };

export const DEFAULT_SETTINGS = {
  alerts: {
    headsUpMin: 10,
    eveningReminder: '19:00',
  },
  commute: {
    bufferMin: 5,
    chainGapMin: 45,
    defaultDriveMin: 20,
    baseFactor: 1.1,
    traffic: [
      { label: 'Weekday morning rush', days: ['MO', 'TU', 'WE', 'TH', 'FR'], from: '06:30', to: '09:00', factor: 1.3 },
      { label: 'Weekday afternoon rush', days: ['MO', 'TU', 'WE', 'TH', 'FR'], from: '14:30', to: '18:30', factor: 1.35 },
    ],
  },
  feed: {
    enabled: true,
    gistId: null,
    gistOwner: null,
    filename: 'family-timetable.ics',
    calendarName: 'Family Timetable',
    daysBack: 7,
    daysAhead: 120,
    appUrl: null,
  },
  display: {
    weekStartsOn: 'MO',
  },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function fillDefaults(target, defaults) {
  for (const [k, v] of Object.entries(defaults)) {
    if (target[k] === undefined) target[k] = clone(v);
    else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') fillDefaults(target[k], v);
  }
  return target;
}

// Make a db safe to use even if someone hand-edited it and left parts out.
// Never removes anything.
export function normalizeDb(db) {
  const d = db && typeof db === 'object' ? db : {};
  d.version ??= DB_VERSION;
  d.meta ??= {};
  d.meta.title ??= 'Family Timetable';
  d.meta.timezone ??= 'America/Phoenix';
  for (const key of ['members', 'places', 'calendars', 'schedules', 'events', 'exceptions', 'holidays']) {
    if (!Array.isArray(d[key])) d[key] = [];
  }
  d.settings = fillDefaults(d.settings && typeof d.settings === 'object' ? d.settings : {}, DEFAULT_SETTINGS);
  d.routes ??= {};
  d.routes.cache ??= {};
  d.routes.overrides ??= {};
  if (!d.places.some((p) => p.id === HOME_ID)) d.places.unshift({ id: HOME_ID, name: 'Home', address: '', lat: null, lng: null, bufferMin: 0 });
  return d;
}

export function emptyDb(timezone = 'America/Phoenix') {
  return normalizeDb({ version: DB_VERSION, meta: { title: 'Family Timetable', timezone } });
}

export function makeIndex(db) {
  return {
    places: new Map(db.places.map((p) => [p.id, p])),
    members: new Map(db.members.map((m) => [m.id, m])),
    calendars: new Map(db.calendars.map((c) => [c.id, c])),
    schedules: new Map(db.schedules.map((s) => [s.id, s])),
    holidays: new Map(db.holidays.map((h) => [h.date, h])),
    exceptions: new Map(db.exceptions.map((e) => [`${e.schedule}@${e.date}`, e])),
  };
}

export const kidsOf = (db) => db.members.filter((m) => m.role === 'kid');

export function namesOf(db, ids, joiner = ' & ') {
  const names = (ids || []).map((id) => db.members.find((m) => m.id === id)?.name || id);
  if (names.length <= 2) return names.join(joiner);
  return `${names.slice(0, -1).join(', ')}${joiner}${names.at(-1)}`;
}

export function placeLabel(place) {
  if (!place) return '';
  return place.short || place.name;
}

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40) || 'item';
}

export function uniqueId(base, taken) {
  const set = taken instanceof Set ? taken : new Set(taken);
  let id = slugify(base);
  let n = 2;
  while (set.has(id)) {
    id = `${slugify(base)}-${n}`;
    n += 1;
  }
  return id;
}
