import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './storage.js';
import { redactError } from './errors.js';

export class ErrorReporter {
  constructor(file) { this.file = file; this.items = []; this.queue = Promise.resolve(); this.send = null; }
  async load() {
    try { this.items = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  serial(fn) { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  report(message, meta = {}) {
    return this.serial(async () => {
      const detail = redactError([meta.error, meta.stack, meta.stderr].filter(Boolean).join('\n')).slice(0, 3500);
      const key = `${message}:${detail}`;
      const existing = this.items.find((item) => item.key === key);
      if (existing) { existing.count++; existing.time = new Date().toISOString(); }
      else this.items.push({ id: randomUUID().slice(0, 8), key, message, detail, time: new Date().toISOString(), jid: meta.jid, messageId: meta.messageId, count: 1 });
      // The daily file logger remains the full record; cap pending unique notifications.
      this.items = this.items.slice(-500);
      await atomicJson(this.file, this.items);
    });
  }
  flush() {
    return this.serial(async () => {
      if (!this.send) return;
      for (const item of [...this.items]) {
        try {
          await this.send([`[Error #${item.id}] ${item.message}`, item.time, `Kejadian: ${item.count}`, item.jid ? `Chat: ${item.jid}` : '', item.messageId ? `Pesan: ${item.messageId}` : '', item.detail].filter(Boolean).join('\n'));
        } catch { break; }
        this.items = this.items.filter((candidate) => candidate.id !== item.id);
        await atomicJson(this.file, this.items);
      }
    });
  }
}
