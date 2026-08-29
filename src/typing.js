import fs from 'node:fs/promises';
import path from 'node:path';
import { TYPING_STATE_FILE } from './config.js';

const DEFAULT_REFRESH_MS = 8_000;
const ERROR_LOG_INTERVAL_MS = 60_000;

export class TypingController {
  constructor({ filePath = TYPING_STATE_FILE, refreshMs = DEFAULT_REFRESH_MS, logger = null } = {}) {
    this.filePath = filePath;
    this.refreshMs = refreshMs;
    this.logger = logger;
    this.targets = [];
    this.sock = null;
    this.timer = null;
    this.lastErrorAt = new Map();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.targets = normalizeTargets(parsed?.targets);
    } catch {
      this.targets = [];
      await this.save();
    }
    return this.snapshot();
  }

  snapshot() {
    return this.targets.map((target) => ({ ...target }));
  }

  async add(target) {
    const normalized = normalizeTarget(target);
    if (!normalized) throw new Error('Target typing tidak valid.');
    const existingIndex = this.targets.findIndex((item) => item.jid === normalized.jid);
    if (existingIndex >= 0) this.targets[existingIndex] = { ...this.targets[existingIndex], ...normalized };
    else this.targets.push(normalized);
    await this.save();
    await this.send('composing', normalized.jid);
    this.ensureTimer();
    return { target: { ...normalized }, added: existingIndex < 0 };
  }

  async stopAll() {
    const stopped = this.snapshot();
    this.targets = [];
    this.stopTimer();
    await this.save();
    await Promise.allSettled(stopped.map((target) => this.send('paused', target.jid)));
    return stopped;
  }

  attach(sock) {
    this.sock = sock || null;
    if (!this.sock) {
      this.stopTimer();
      return;
    }
    void this.refresh();
    this.ensureTimer();
  }

  detach() {
    this.sock = null;
    this.stopTimer();
  }

  async refresh() {
    if (!this.sock || !this.targets.length) return;
    await Promise.allSettled(this.targets.map((target) => this.send('composing', target.jid)));
  }

  ensureTimer() {
    if (this.timer || !this.sock || !this.targets.length) return;
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async send(type, jid) {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(type, jid);
      this.lastErrorAt.delete(jid);
    } catch (error) {
      const now = Date.now();
      const lastLoggedAt = this.lastErrorAt.get(jid) || 0;
      if (now - lastLoggedAt >= ERROR_LOG_INTERVAL_MS) {
        this.lastErrorAt.set(jid, now);
        await this.logger?.warn?.('Typing presence update failed', { jid, type, error: error.message });
      }
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify({
      targets: this.targets,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`);
  }
}

function normalizeTargets(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const raw of value) {
    const target = normalizeTarget(raw);
    if (!target) continue;
    const existing = result.findIndex((item) => item.jid === target.jid);
    if (existing >= 0) result[existing] = target;
    else result.push(target);
  }
  return result;
}

function normalizeTarget(value) {
  const jid = String(value?.jid || '').trim();
  if (!jid || (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@g.us') && !jid.endsWith('@lid'))) return null;
  return {
    jid,
    name: String(value?.name || jid).trim() || jid,
    type: jid.endsWith('@g.us') ? 'group' : 'user',
    addedAt: value?.addedAt || new Date().toISOString()
  };
}
