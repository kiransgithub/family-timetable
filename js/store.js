// Holds the db, keeps it in sync with db.json in the private GitHub repo
// (or in this browser only, in local mode) and republishes the calendar
// feed after each change.

import { normalizeDb } from './core/model.js';
import { validateDb } from './core/validate.js';
import { buildIcs } from './core/ics.js';
import { normalizeRewards, validateRewards } from './core/rewards.js';
import * as gh from './services/github.js';

const K = {
  cfg: 'ftm.github',
  mode: 'ftm.mode',
  db: 'ftm.db',
  sha: 'ftm.sha',
  lastSync: 'ftm.lastSync',
  device: 'ftm.device',
  feedAt: 'ftm.feedPublishedAt',
  rewards: 'ftm.rewards',
  rewardsSha: 'ftm.rewards.sha',
  rewardsRepo: 'ftm.rewards.repo',
};

const ls = {
  get(k, fallback = null) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore quota errors */
    }
  },
};

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.slice(0, 3).join(' '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export function defaultDeviceName() {
  const ua = navigator.userAgent || '';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Browser';
}

export class Store extends EventTarget {
  constructor() {
    super();
    this.mode = ls.get(K.mode, 'none'); // 'github' | 'local' | 'none'
    this.config = ls.get(K.cfg, null);
    this.db = null;
    this.sha = ls.get(K.sha, null);
    this.lastSync = ls.get(K.lastSync, null);
    this.status = 'idle'; // idle | loading | synced | saving | offline | error | missing
    this.error = null;
    this.feedStatus = null;
    this.feedTimer = null;
    this.queue = Promise.resolve();
    this.deviceName = ls.get(K.device, null) || defaultDeviceName();
    const cached = ls.get(K.db, null);
    if (cached) this.db = normalizeDb(cached);
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit();
  }

  get canWrite() {
    return this.mode === 'local' || (this.mode === 'github' && !!this.config?.token);
  }

  setDeviceName(name) {
    this.deviceName = name || defaultDeviceName();
    ls.set(K.device, this.deviceName);
    this.emit();
  }

  cache() {
    ls.set(K.db, this.db);
    ls.set(K.sha, this.sha);
  }

  // ---- connection ---------------------------------------------------------

  async connect(config) {
    const cfg = { branch: 'main', path: 'db.json', ...config };
    cfg.owner = cfg.owner.trim();
    cfg.repo = cfg.repo.trim();
    cfg.token = cfg.token.trim();
    await gh.getRepo(cfg); // throws with a readable message if the repo or token is wrong
    const sameRepo = this.config && this.config.owner === cfg.owner && this.config.repo === cfg.repo && this.config.path === cfg.path;
    this.config = cfg;
    this.mode = 'github';
    ls.set(K.cfg, cfg);
    ls.set(K.mode, 'github');
    if (!sameRepo) {
      this.sha = null;
      this.db = null;
      this.cache();
    }
    await this.refresh();
  }

  useLocal(db) {
    this.mode = 'local';
    ls.set(K.mode, 'local');
    this.db = normalizeDb(db);
    this.sha = null;
    this.cache();
    this.setStatus('synced');
  }

  disconnect() {
    this.mode = 'none';
    this.config = null;
    this.db = null;
    this.sha = null;
    for (const k of Object.values(K)) if (k !== K.device) ls.set(k, null);
    this.setStatus('idle');
  }

  // ---- reading -------------------------------------------------------------

  async refresh({ quiet = false } = {}) {
    if (this.mode === 'local') {
      if (!this.db) this.setStatus('missing');
      else this.setStatus('synced');
      return;
    }
    if (this.mode !== 'github' || !this.config) return;
    if (!quiet || !this.db) this.setStatus('loading');
    try {
      const { text, sha } = await gh.readFile(this.config);
      if (sha !== this.sha || !this.db) {
        this.db = normalizeDb(JSON.parse(text));
        this.sha = sha;
        this.cache();
      }
      this.lastSync = Date.now();
      ls.set(K.lastSync, this.lastSync);
      this.setStatus('synced');
    } catch (e) {
      if (e.status === 404) this.setStatus('missing', `No ${this.config.path} in ${this.config.owner}/${this.config.repo} yet.`);
      else if (e instanceof SyntaxError) this.setStatus('error', `${this.config.path} is not valid JSON: ${e.message}`);
      else if (e.status === 0) this.setStatus('offline', e.message);
      else this.setStatus('error', e.message);
    }
  }

  // ---- writing -------------------------------------------------------------

  // `fn(draft)` edits a copy of the db. On a conflict (someone else saved
  // first) the latest db is fetched and `fn` is applied again.
  // Saves run one at a time so two quick edits never race each other.
  mutate(fn, message = 'Update timetable') {
    const run = this.queue.catch(() => {}).then(() => this.mutateNow(fn, message));
    this.queue = run;
    return run;
  }

  async mutateNow(fn, message) {
    if (!this.db) throw new Error('Nothing loaded yet.');
    if (!this.canWrite) throw new Error('This device is view-only. Add a token with write access under Manage → Data & sync.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let draft = normalizeDb(structuredClone(this.db));
      const result = fn(draft);
      if (result === false) return false; // nothing to change
      if (result && typeof result === 'object') draft = normalizeDb(structuredClone(result)); // full replacement
      draft.meta.updatedAt = new Date().toISOString();
      draft.meta.updatedBy = this.deviceName;
      const { errors } = validateDb(draft);
      if (errors.length) throw new ValidationError(errors);
      const text = `${JSON.stringify(draft, null, 2)}\n`;
      if (this.mode === 'local') {
        this.db = draft;
        this.cache();
        this.setStatus('synced');
        this.scheduleFeed();
        return true;
      }
      this.setStatus('saving');
      try {
        this.sha = await gh.writeFile(this.config, text, this.sha, `${message} (${this.deviceName})`);
        this.db = draft;
        this.lastSync = Date.now();
        ls.set(K.lastSync, this.lastSync);
        this.cache();
        this.setStatus('synced');
        this.scheduleFeed();
        return true;
      } catch (e) {
        if (e.isConflict && attempt < 2) {
          const { text: latest, sha } = await gh.readFile(this.config);
          this.db = normalizeDb(JSON.parse(latest));
          this.sha = sha;
          continue;
        }
        this.setStatus(e.status === 0 ? 'offline' : 'error', e.message);
        throw e;
      }
    }
    return false;
  }

  // Create db.json in an empty repo (first-time setup or import).
  async createRemote(db, message = 'Create timetable db') {
    const draft = normalizeDb(structuredClone(db));
    const { errors } = validateDb(draft);
    if (errors.length) throw new ValidationError(errors);
    draft.meta.updatedAt = new Date().toISOString();
    draft.meta.updatedBy = this.deviceName;
    let sha = null;
    try {
      sha = (await gh.readFile(this.config)).sha; // overwrite if it exists
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    this.sha = await gh.writeFile(this.config, `${JSON.stringify(draft, null, 2)}\n`, sha, `${message} (${this.deviceName})`);
    this.db = draft;
    this.cache();
    this.setStatus('synced');
    this.scheduleFeed();
  }

  // ---- calendar feed -------------------------------------------------------

  feedInfo() {
    const f = this.db?.settings?.feed;
    if (!f?.gistId || !f?.gistOwner) return null;
    return gh.feedUrls(f.gistOwner, f.gistId, f.filename || 'family-timetable.ics');
  }

  scheduleFeed(delay = 2500) {
    if (this.mode !== 'github' || !this.db?.settings?.feed?.enabled || !this.db.settings.feed.gistId) return;
    clearTimeout(this.feedTimer);
    this.feedTimer = setTimeout(() => this.publishFeed().catch(() => {}), delay);
  }

  async publishFeed({ create = false } = {}) {
    if (this.mode !== 'github' || !this.config?.token) throw new Error('Connect a GitHub token first.');
    const feed = this.db.settings.feed;
    const filename = feed.filename || 'family-timetable.ics';
    const ics = buildIcs(this.db, { nowMs: Date.now() });
    try {
      if (!feed.gistId) {
        if (!create) return null;
        const g = await gh.createGist(this.config.token, { description: 'Family Timetable calendar feed (private link)', filename, content: ics });
        await this.mutate((d) => {
          d.settings.feed.gistId = g.id;
          d.settings.feed.gistOwner = g.owner?.login || this.config.owner;
        }, 'Set calendar feed');
      } else {
        await gh.updateGist(this.config.token, feed.gistId, filename, ics);
      }
      ls.set(K.feedAt, Date.now());
      this.feedStatus = { ok: true, at: Date.now() };
    } catch (e) {
      this.feedStatus = { ok: false, at: Date.now(), error: e.message };
      this.emit();
      throw e;
    }
    this.emit();
    return this.feedInfo();
  }

  get feedPublishedAt() {
    return ls.get(K.feedAt, null);
  }

  // ---- setup codes -------------------------------------------------------------

  setupCode(includeToken = true) {
    if (!this.config) return null;
    const c = this.config;
    const payload = { o: c.owner, r: c.repo, b: c.branch, p: c.path };
    if (includeToken) payload.t = c.token;
    return `ftm1.${btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/=+$/, '')}`;
  }

  static parseSetupCode(code) {
    const m = String(code || '').trim().match(/ftm1\.([A-Za-z0-9+/_-]+)/);
    if (!m) return null;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const p = JSON.parse(decodeURIComponent(escape(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))));
      if (!p.o || !p.r) return null;
      return { owner: p.o, repo: p.r, branch: p.b || 'main', path: p.p || 'db.json', token: p.t || '' };
    } catch {
      return null;
    }
  }
}

// ---- rewards.json ------------------------------------------------------------------
// The rewards ledger is its own file next to db.json in the same private repo,
// so timetable edits (raw JSON, imports) can never touch balances. Changes go
// through the password-gated Rewards tab only.

export function rewardsPath(dbPath = 'db.json') {
  return dbPath.includes('/') ? dbPath.replace(/[^/]*$/, 'rewards.json') : 'rewards.json';
}

export class RewardsStore extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.data = null;
    this.sha = ls.get(K.rewardsSha, null);
    this.status = 'idle'; // idle | loading | synced | saving | offline | error | missing
    this.error = null;
    this.queue = Promise.resolve();
    const cached = ls.get(K.rewards, null);
    if (cached && ls.get(K.rewardsRepo, null) === this.repoKey) this.data = normalizeRewards(cached);
  }

  get repoKey() {
    const c = this.store.config;
    if (this.store.mode === 'local') return 'local';
    return c ? `${c.owner}/${c.repo}/${rewardsPath(c.path)}` : null;
  }

  get cfg() {
    const c = this.store.config;
    return c ? { ...c, path: rewardsPath(c.path) } : null;
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit();
  }

  cache() {
    ls.set(K.rewards, this.data);
    ls.set(K.rewardsSha, this.sha);
    ls.set(K.rewardsRepo, this.data ? this.repoKey : null);
  }

  async refresh({ quiet = false } = {}) {
    const mode = this.store.mode;
    if (ls.get(K.rewardsRepo, null) && ls.get(K.rewardsRepo, null) !== this.repoKey) {
      this.data = null;
      this.sha = null;
      this.cache();
    }
    if (mode === 'local') {
      this.setStatus(this.data ? 'synced' : 'missing');
      return;
    }
    if (mode !== 'github' || !this.store.config) {
      this.data = null;
      this.setStatus('idle');
      return;
    }
    if (!quiet || !this.data) this.setStatus('loading');
    try {
      const { text, sha } = await gh.readFile(this.cfg);
      if (sha !== this.sha || !this.data) {
        this.data = normalizeRewards(JSON.parse(text));
        this.sha = sha;
        this.cache();
      }
      this.setStatus('synced');
    } catch (e) {
      if (e.status === 404) {
        this.data = null;
        this.sha = null;
        this.cache();
        this.setStatus('missing');
      } else if (e instanceof SyntaxError) this.setStatus('error', `rewards.json is not valid JSON: ${e.message}`);
      else if (e.status === 0) this.setStatus('offline', e.message);
      else this.setStatus('error', e.message);
    }
  }

  // Same pattern as the timetable: edit a copy, validate, save with the
  // file's sha, and on a conflict re-apply `fn` to the newest version.
  // `fn` may throw (e.g. "not enough balance") after seeing the newest data.
  mutate(fn, message = 'Update rewards') {
    const run = this.queue.catch(() => {}).then(() => this.mutateNow(fn, message));
    this.queue = run;
    return run;
  }

  async mutateNow(fn, message) {
    if (!this.data) throw new Error('Rewards are not loaded yet.');
    if (!this.store.canWrite) throw new Error('This device is view-only.');
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let draft = normalizeRewards(structuredClone(this.data));
        const result = fn(draft);
        if (result === false) return false;
        if (result && typeof result === 'object') draft = normalizeRewards(structuredClone(result));
        draft.updatedAt = new Date().toISOString();
        draft.updatedBy = this.store.deviceName;
        const { errors } = validateRewards(draft, { members: this.store.db?.members });
        if (errors.length) throw new ValidationError(errors);
        if (this.store.mode === 'local') {
          this.data = draft;
          this.cache();
          this.setStatus('synced');
          return true;
        }
        this.setStatus('saving');
        try {
          this.sha = await gh.writeFile(this.cfg, `${JSON.stringify(draft, null, 2)}\n`, this.sha, `${message} (${this.store.deviceName})`);
          this.data = draft;
          this.cache();
          this.setStatus('synced');
          return true;
        } catch (e) {
          if (!e.isConflict || attempt >= 2) throw e;
          // Someone else saved first: load their version and re-apply.
          const { text, sha } = await gh.readFile(this.cfg);
          this.data = normalizeRewards(JSON.parse(text));
          this.sha = sha;
          this.cache();
        }
      }
      return false;
    } catch (e) {
      if (e.status === 0) this.setStatus('offline', e.message);
      else if (e.status) this.setStatus('error', e.message);
      else if (this.status === 'saving') this.setStatus('synced'); // a rule in fn or validation said no after a conflict reload; nothing was written
      throw e;
    }
  }

  // First-time setup: write a fresh rewards.json. Never overwrites one that
  // already exists (another device may have just created it): that one is
  // loaded instead.
  async create(data, message = 'Set up rewards') {
    const draft = normalizeRewards(structuredClone(data));
    const { errors } = validateRewards(draft, { members: this.store.db?.members });
    if (errors.length) throw new ValidationError(errors);
    if (this.store.mode === 'local') {
      if (this.data) return false;
      this.data = draft;
      this.cache();
      this.setStatus('synced');
      return true;
    }
    if (!this.store.canWrite) throw new Error('This device is view-only.');
    try {
      const { text, sha } = await gh.readFile(this.cfg);
      this.data = normalizeRewards(JSON.parse(text));
      this.sha = sha;
      this.cache();
      this.setStatus('synced');
      return false;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    this.sha = await gh.writeFile(this.cfg, `${JSON.stringify(draft, null, 2)}\n`, null, `${message} (${this.store.deviceName})`);
    this.data = draft;
    this.cache();
    this.setStatus('synced');
    return true;
  }
}
