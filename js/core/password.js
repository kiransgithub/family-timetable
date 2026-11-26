// Parent passwords for the rewards lock. Only a salted PBKDF2-SHA256 hash
// is stored (in rewards.json in the private data repo), never the password.
// Uses Web Crypto, so it works in browsers (HTTPS or localhost) and Node.

const encoder = new TextEncoder();

export const DEFAULT_ITERATIONS = 600000;
export const MIN_LENGTH = 6;

const subtle = () => globalThis.crypto?.subtle;

export function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function fromB64(s) {
  const bin = atob(String(s));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function hashPassword(password, { iterations = DEFAULT_ITERATIONS, salt } = {}) {
  if (!subtle()) throw new Error('This browser cannot check passwords here. Open the app over HTTPS.');
  const saltBytes = salt ? fromB64(salt) : globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await subtle().importKey('raw', encoder.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
  return { alg: 'PBKDF2-SHA256', iterations, salt: toB64(saltBytes), hash: toB64(new Uint8Array(bits)) };
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, record) {
  if (!record?.hash || !record?.salt || !Number.isFinite(record.iterations)) return false;
  const { hash } = await hashPassword(password, { iterations: record.iterations, salt: record.salt });
  return sameString(hash, record.hash);
}

const COMMON = ['123456', '1234567', '12345678', 'password', 'qwerty', 'abc123', '111111', 'letmein', 'iloveyou'];

// A reason the password is too weak, or null when it is fine.
export function passwordProblem(pw) {
  const p = String(pw || '');
  if (p.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (/^(.)\1+$/.test(p)) return 'Avoid repeating one character.';
  if (COMMON.includes(p.toLowerCase())) return 'That one is too easy to guess.';
  return null;
}
