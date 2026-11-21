// GitHub REST calls used by the app: read/write db.json in the private
// data repo (Contents API) and keep the calendar feed in a secret gist.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
  get isConflict() {
    return this.status === 409 || (this.status === 422 && /sha/i.test(this.message));
  }
}

export function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64decodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function call(token, method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new GitHubError(0, 'Could not reach GitHub. Check your connection.', null);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    let msg = json?.message || res.statusText || `HTTP ${res.status}`;
    if (res.status === 401) msg = 'GitHub rejected the token (expired or mistyped).';
    if (res.status === 403 && /rate limit/i.test(msg)) msg = 'GitHub rate limit reached. Try again in a few minutes.';
    else if (res.status === 403) msg = 'This token is not allowed to do that (check its permissions).';
    throw new GitHubError(res.status, msg, json);
  }
  return json;
}

const seg = (s) => encodeURIComponent(s);
const filePath = (p) => p.split('/').map(seg).join('/');
const contentsUrl = (cfg) => `/repos/${seg(cfg.owner)}/${seg(cfg.repo)}/contents/${filePath(cfg.path)}`;

export async function readFile(cfg) {
  const j = await call(cfg.token, 'GET', `${contentsUrl(cfg)}?ref=${seg(cfg.branch)}`);
  if (Array.isArray(j) || j.type !== 'file') throw new GitHubError(400, `${cfg.path} is not a file.`, j);
  return { text: b64decodeUtf8(j.content), sha: j.sha };
}

export async function writeFile(cfg, text, sha, message) {
  const body = { message, content: b64encodeUtf8(text), branch: cfg.branch };
  if (sha) body.sha = sha;
  const j = await call(cfg.token, 'PUT', contentsUrl(cfg), body);
  return j.content.sha;
}

export const getUser = (token) => call(token, 'GET', '/user');
export const getRepo = (cfg) => call(cfg.token, 'GET', `/repos/${seg(cfg.owner)}/${seg(cfg.repo)}`);

export async function createGist(token, { description, filename, content }) {
  return call(token, 'POST', '/gists', { description, public: false, files: { [filename]: { content } } });
}

export async function updateGist(token, id, filename, content) {
  return call(token, 'PATCH', `/gists/${seg(id)}`, { files: { [filename]: { content } } });
}

export function feedUrls(owner, id, filename) {
  const https = `https://gist.githubusercontent.com/${owner}/${id}/raw/${encodeURIComponent(filename)}`;
  return { https, webcal: https.replace(/^https:/, 'webcal:') };
}
