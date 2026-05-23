import { LINKS_FILE, NOTES_FILE } from './config.js';
import {
  addNamedItem,
  deleteNamedItem,
  findByIdOrTitle,
  formatNamedList,
  readCollection,
  renameNamedItem
} from './namedStore.js';

const LINK_RE = /^https?:\/\/\S+$/i;

export async function handleNoteCommand(command, file = NOTES_FILE) {
  if (!command.args.length) {
    return formatNamedList(await listNotes(file), 'Belum ada note.');
  }
  if (command.args[0].toLowerCase() === 'change') {
    const query = command.args[1];
    const newTitle = command.args.slice(2).join(' ').trim();
    if (!query || !newTitle) throw new Error('Format: ,note change <id|judul-lama> <judul-baru>');
    const item = await renameNamedItem(file, query, newTitle, 'Note');
    return `Note #${item.id} diganti judul menjadi "${item.title}".`;
  }
  if (command.args[0].toLowerCase() === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,note del <id|judul>');
    const item = await deleteNamedItem(file, query, 'Note');
    return `Note #${item.id} "${item.title}" dihapus.`;
  }
  if (command.args.length === 1) {
    const item = await getNote(command.args[0], file);
    if (!item) throw new Error(`Note "${command.args[0]}" tidak ditemukan.`);
    return `#${item.id} - ${item.title}\n${item.text}`;
  }

  const title = command.args[0];
  const text = command.args.slice(1).join(' ').trim();
  if (!text) throw new Error('Format: ,note <judul> <teks>');
  const item = await addNamedItem(file, title, { text });
  return `Note #${item.id} "${item.title}" tersimpan.`;
}

export async function handleLinkCommand(command, file = LINKS_FILE) {
  if (!command.args.length) {
    return formatNamedList(await listLinks(file), 'Belum ada link.');
  }
  if (command.args[0].toLowerCase() === 'change') {
    const query = command.args[1];
    const newTitle = command.args.slice(2).join(' ').trim();
    if (!query || !newTitle) throw new Error('Format: ,link change <id|nama-lama> <nama-baru>');
    const item = await renameNamedItem(file, query, newTitle, 'Link');
    return `Link #${item.id} diganti nama menjadi "${item.title}".`;
  }
  if (command.args[0].toLowerCase() === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,link del <id|nama>');
    const item = await deleteNamedItem(file, query, 'Link');
    return `Link #${item.id} "${item.title}" dihapus.`;
  }
  if (command.args.length === 1) {
    const item = await getLink(command.args[0], file);
    if (!item) throw new Error(`Link "${command.args[0]}" tidak ditemukan.`);
    return `#${item.id} - ${item.title}\n${item.url}`;
  }

  const title = command.args[0];
  const url = command.args[1];
  if (!LINK_RE.test(url || '')) throw new Error('Format: ,link <nama> <https://link>');
  const item = await addNamedItem(file, title, { url });
  return `Link #${item.id} "${item.title}" tersimpan.`;
}

export async function listNotes(file = NOTES_FILE) {
  return (await readCollection(file)).items;
}

export async function listLinks(file = LINKS_FILE) {
  return (await readCollection(file)).items;
}

export async function getNote(query, file = NOTES_FILE) {
  const store = await readCollection(file);
  return findByIdOrTitle(store, query);
}

export async function getLink(query, file = LINKS_FILE) {
  const store = await readCollection(file);
  return findByIdOrTitle(store, query);
}
