export class PendingConfirmStore {
  constructor({ ttlMs = 2 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }

  set(jid, action) {
    if (!jid || !action?.execute) throw new Error('Pending confirm action tidak valid.');
    const item = {
      ...action,
      jid,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs
    };
    this.pending.set(jid, item);
    return item;
  }

  get(jid) {
    const item = this.pending.get(jid);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.pending.delete(jid);
      return null;
    }
    return item;
  }

  take(jid) {
    const item = this.get(jid);
    if (item) this.pending.delete(jid);
    return item;
  }

  cancel(jid) {
    return this.pending.delete(jid);
  }

  count() {
    this.cleanupExpired();
    return this.pending.size;
  }

  cleanupExpired() {
    const now = Date.now();
    for (const [jid, item] of this.pending.entries()) {
      if (item.expiresAt <= now) this.pending.delete(jid);
    }
  }
}

export function parseSecretMediaTriggerText(text) {
  const value = String(text || '');
  if (!value.endsWith(' .')) return null;
  return {
    caption: value.slice(0, -2).trim()
  };
}
