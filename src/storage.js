import fs from 'node:fs/promises';
import path from 'node:path';
import { UserInputError } from './errors.js';

export const STORAGE_FEATURES = ['statussave', 'backup', 'logs', 'changedmsg'];
export const destinationAlias = (feature) => feature === 'statussave' ? 'saved' : feature;
export function safeComponent(value, fallback = 'unknown') {
  const clean = String(value || '').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+|[. ]+$/g, '').trim();
  return [...(clean || fallback)].slice(0, 90).join('');
}
export function wibDay(time = Date.now()) {
  return new Date(Number(time) + 7 * 3600000).toISOString().slice(0, 10);
}
export async function prepareLocalPath(raw) {
  if (!raw || !path.isAbsolute(raw)) throw new UserInputError('Gunakan path server absolut, contoh /home/iro/hdd35/services/Irobot-wa.');
  const dir = path.resolve(raw);
  await fs.mkdir(dir, { recursive: true });
  await fs.access(dir, fs.constants.W_OK);
  const probe = path.join(dir, `.write-check-${process.pid}-${Date.now()}`);
  await fs.writeFile(probe, '', { flag: 'wx' });
  await fs.unlink(probe);
  return dir;
}
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, file);
}
// Keeps contact folders stable after renames; serializes name allocation and writes.
export class LocalArchive {
  constructor() { this.pending = Promise.resolve(); }
  write(root, data) {
    const task = this.pending.then(() => this.writeItem(root, data));
    this.pending = task.catch(() => {});
    return task;
  }
  async writeItem(root, { identity, name, timestamp, id, text, media, metadata = {} }) {
    const mapFile = path.join(root, '.folders.json');
    let map = {};
    try { map = JSON.parse(await fs.readFile(mapFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!map[identity]) {
      const number = String(identity).split('@')[0];
      let folder = safeComponent(name || number);
      if (Object.values(map).some((item) => item.toLowerCase() === folder.toLowerCase())) folder = safeComponent(`${folder} (${number})`);
      map[identity] = folder;
      await atomicJson(mapFile, map);
    }
    const dir = path.join(root, map[identity], wibDay(timestamp));
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date(Number(timestamp) + 7 * 3600000).toISOString().slice(11, 19).replaceAll(':', '-');
    const base = path.join(dir, `${stamp}-${safeComponent(id)}`);
    let mediaPath;
    if (media?.path) {
      const ext = path.extname(media.path).replace(/[^.a-z0-9]/gi, '') || '.bin';
      mediaPath = `${base}${ext}`;
      await fs.copyFile(media.path, `${mediaPath}.tmp`);
      await fs.rename(`${mediaPath}.tmp`, mediaPath);
    }
    if (text) await fs.writeFile(`${base}.txt`, text);
    await atomicJson(`${base}.json`, { ...metadata, identity, timestamp, text, mediaPath });
    return { path: `${base}.json`, mediaPath };
  }
}
