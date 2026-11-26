import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { atomicJson } from './storage.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_LENGTH = 24;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 5;

export function generateKey(length = KEY_LENGTH) {
  const bytes = crypto.randomBytes(length);
  const chars = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
  return chars.match(/.{1,4}/g).join('-');
}

// Dashes, spaces and case do not matter when typing the key.
export const normalizeKey = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function hashKey(key, salt) {
  return crypto.scryptSync(normalizeKey(key), salt, 32, { N: 16384, r: 8, p: 1 });
}

// One admin key for the Web UI. Only a scrypt hash is stored, so the key is shown once.
export class ImportantAuth {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = { hash: '', salt: '', createdAt: null, generation: 0 };
    this.sessions = new Map();
    this.failures = new Map();
  }

  async load() {
    try {
      const { sessions = {}, ...saved } = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = { ...this.data, ...saved };
      for (const [hash, session] of Object.entries(sessions)) {
        if (session.expires > this.now() && session.generation === this.data.generation) this.sessions.set(hash, session);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  hasKey() { return Boolean(this.data.hash); }

  // Sessions survive a bot restart; only a hash of each cookie token is written.
  async save() {
    await atomicJson(this.file, { ...this.data, sessions: Object.fromEntries(this.sessions) });
  }

  // Creates the first key, or a new one on reset. Every open web session is logged out.
  async createKey() {
    const key = generateKey();
    const salt = crypto.randomBytes(16);
    this.data = {
      hash: hashKey(key, salt).toString('base64'),
      salt: salt.toString('base64'),
      createdAt: new Date(this.now()).toISOString(),
      generation: (this.data.generation || 0) + 1
    };
    this.sessions.clear();
    await this.save();
    return key;
  }

  blocked(ip) {
    const entry = this.failures.get(ip);
    if (!entry) return 0;
    if (this.now() - entry.first > FAIL_WINDOW_MS) {
      this.failures.delete(ip);
      return 0;
    }
    return entry.count >= FAIL_LIMIT ? Math.ceil((entry.first + FAIL_WINDOW_MS - this.now()) / 1000) : 0;
  }

  verify(key) {
    if (!this.hasKey() || !normalizeKey(key)) return false;
    const expected = Buffer.from(this.data.hash, 'base64');
    const actual = hashKey(key, Buffer.from(this.data.salt, 'base64'));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  // Returns { token } on success, { retryAfter } when rate limited, or {} on a wrong key.
  async login(key, ip = 'unknown') {
    const retryAfter = this.blocked(ip);
    if (retryAfter) return { retryAfter };
    if (!this.verify(key)) {
      const entry = this.failures.get(ip) || { first: this.now(), count: 0 };
      entry.count += 1;
      this.failures.set(ip, entry);
      return {};
    }
    this.failures.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(tokenHash(token), { expires: this.now() + SESSION_MS, generation: this.data.generation });
    await this.save();
    return { token, maxAge: Math.floor(SESSION_MS / 1000) };
  }

  check(token) {
    if (!token) return false;
    const session = this.sessions.get(tokenHash(token));
    if (!session) return false;
    if (session.expires < this.now() || session.generation !== this.data.generation) {
      this.sessions.delete(tokenHash(token));
      return false;
    }
    return true;
  }

  async logout(token) {
    if (this.sessions.delete(tokenHash(String(token || '')))) await this.save();
  }
}
