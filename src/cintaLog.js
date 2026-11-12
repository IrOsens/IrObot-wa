import fs from 'node:fs/promises';
import { atomicJson } from './storage.js';
import { formatWib } from './tasks.js';

const MAX_RECENT = 20;
const MAX_PEOPLE_SHOWN = 20;
const MAX_RECENT_SHOWN = 5;
const logs = new Map();

function emptyLog() {
  return { total: 0, replied: 0, people: {}, recent: [] };
}

// One shared instance per file so concurrent writes from different scopes never overwrite each other.
export function cintaLogFor(file) {
  if (!logs.has(file)) logs.set(file, new CintaLog(file));
  return logs.get(file);
}

export class CintaLog {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.data) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = { ...emptyLog(), ...parsed };
    } catch {
      this.data = emptyLog();
    }
  }

  record(entry) {
    const task = this.queue.then(() => this.write(entry));
    this.queue = task.catch(() => {});
    return task;
  }

  async write({ key, phone, name, via, replied }) {
    await this.load();
    const now = new Date().toISOString();
    const person = this.data.people[key] || { key, phone: null, name: '', triggers: 0, replied: 0, byText: 0, byReaction: 0, firstAt: now, lastAt: now };
    person.phone = phone || person.phone;
    person.name = name || person.name;
    person.triggers += 1;
    if (replied) person.replied += 1;
    if (via === 'reaksi') person.byReaction += 1;
    else person.byText += 1;
    person.lastAt = now;
    this.data.people[key] = person;
    this.data.total += 1;
    if (replied) this.data.replied += 1;
    this.data.recent = [{ at: now, key, via, replied }, ...this.data.recent].slice(0, MAX_RECENT);
    await atomicJson(this.file, this.data);
  }

  async snapshot() {
    await this.queue;
    await this.load();
    return JSON.parse(JSON.stringify(this.data));
  }
}

function personLabel(person) {
  const number = person.phone ? `+${person.phone}` : `LID ${String(person.key).split('@')[0]}`;
  return person.name ? `${number} (${person.name})` : number;
}

export function formatCintaLog(data) {
  const people = Object.values(data.people).sort((left, right) => right.triggers - left.triggers || right.lastAt.localeCompare(left.lastAt));
  if (!data.total) return 'Log cinta masih kosong. Belum ada yang memakai trigger.';
  const lines = [
    '*Log service cinta*',
    `Total pemakaian trigger: ${data.total}`,
    `Dibalas: ${data.replied}, ditahan batas anti-banned: ${data.total - data.replied}`,
    `Jumlah nomor: ${people.length}`,
    '',
    '*Per nomor*'
  ];
  for (const person of people.slice(0, MAX_PEOPLE_SHOWN)) {
    lines.push(`${personLabel(person)} - ${person.triggers}x (dibalas ${person.replied}, teks ${person.byText}, reaksi ${person.byReaction})`);
    lines.push(`  Terakhir: ${formatWib(person.lastAt)}`);
  }
  if (people.length > MAX_PEOPLE_SHOWN) lines.push(`...dan ${people.length - MAX_PEOPLE_SHOWN} nomor lain.`);
  lines.push('', '*Terbaru*');
  for (const item of data.recent.slice(0, MAX_RECENT_SHOWN)) {
    const person = data.people[item.key];
    lines.push(`${formatWib(item.at)} - ${person ? personLabel(person) : item.key} - ${item.via}${item.replied ? '' : ' (ditahan)'}`);
  }
  return lines.join('\n');
}
