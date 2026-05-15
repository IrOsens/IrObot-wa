import fs from 'node:fs/promises';
import path from 'node:path';

export function emptyCollection() {
  return { nextId: 1, items: [] };
}

export async function readCollection(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      nextId: Number.isInteger(parsed.nextId) ? parsed.nextId : 1,
      items: Array.isArray(parsed.items) ? parsed.items : []
    };
  } catch {
    return emptyCollection();
  }
}

export async function writeCollection(file, store) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`);
}

export function titleKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function findByIdOrTitle(store, query) {
  const text = String(query || '').trim();
  if (!text) return null;
  const id = Number(text);
  if (Number.isInteger(id)) return store.items.find((item) => item.id === id) || null;
  const key = titleKey(text);
  return store.items.find((item) => titleKey(item.title) === key) || null;
}

export function assertUniqueTitle(store, title, ignoreId = null) {
  const key = titleKey(title);
  if (!key) throw new Error('Judul wajib diisi.');
  const exists = store.items.find((item) => titleKey(item.title) === key && item.id !== ignoreId);
  if (exists) throw new Error(`Judul "${title}" sudah ada (#${exists.id}).`);
}

export async function addNamedItem(file, title, payload) {
  const store = await readCollection(file);
  assertUniqueTitle(store, title);
  const item = {
    id: store.nextId++,
    title: String(title).trim(),
    ...payload,
    createdAt: new Date().toISOString()
  };
  store.items.push(item);
  await writeCollection(file, store);
  return item;
}

export async function deleteNamedItem(file, query, label = 'Item') {
  const store = await readCollection(file);
  const item = findByIdOrTitle(store, query);
  if (!item) throw new Error(`${label} "${query}" tidak ditemukan.`);
  store.items = store.items.filter((candidate) => candidate.id !== item.id);
  await writeCollection(file, store);
  return item;
}

export async function renameNamedItem(file, query, newTitle, label = 'Item') {
  const store = await readCollection(file);
  const item = findByIdOrTitle(store, query);
  if (!item) throw new Error(`${label} "${query}" tidak ditemukan.`);
  assertUniqueTitle(store, newTitle, item.id);
  item.title = String(newTitle).trim();
  item.updatedAt = new Date().toISOString();
  await writeCollection(file, store);
  return item;
}

export function formatNamedList(items, emptyText) {
  if (!items.length) return emptyText;
  return items.map((item) => `#${item.id} - ${item.title}`).join('\n');
}
