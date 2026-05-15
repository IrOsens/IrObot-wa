import { LINKS_FILE, NOTES_FILE } from './config.js';
import {
  addNamedItem,
  deleteNamedItem,
  findByIdOrTitle,
  formatNamedList,
  readCollection
} from './namedStore.js';

const LINK_RE = /^https?:\/\/\S+$/i;

export async function handleNoteCommand(command) {
  if (!command.args.length) {
    return formatNamedList(await listNotes(), 'Belum ada note.');
  }
  if (command.args[0].toLowerCase() === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,note del <id|judul>');
    const item = await deleteNamedItem(NOTES_FILE, query, 'Note');
    return `Note #${item.id} "${item.title}" dihapus.`;
  }
  if (command.args.length === 1) {
    const item = await getNote(command.args[0]);
    if (!item) throw new Error(`Note "${command.args[0]}" tidak ditemukan.`);
    return `#${item.id} - ${item.title}\n${item.text}`;
  }

  const title = command.args[0];
  const text = command.args.slice(1).join(' ').trim();
  if (!text) throw new Error('Format: ,note <judul> <teks>');
  const item = await addNamedItem(NOTES_FILE, title, { text });
  return `Note #${item.id} "${item.title}" tersimpan.`;
}

export async function handleLinkCommand(command) {
  if (!command.args.length) {
    return formatNamedList(await listLinks(), 'Belum ada link.');
  }
  if (command.args[0].toLowerCase() === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error('Format: ,link del <id|nama>');
    const item = await deleteNamedItem(LINKS_FILE, query, 'Link');
    return `Link #${item.id} "${item.title}" dihapus.`;
  }
  if (command.args.length === 1) {
    const item = await getLink(command.args[0]);
    if (!item) throw new Error(`Link "${command.args[0]}" tidak ditemukan.`);
    return `#${item.id} - ${item.title}\n${item.url}`;
  }

  const title = command.args[0];
  const url = command.args[1];
  if (!LINK_RE.test(url || '')) throw new Error('Format: ,link <nama> <https://link>');
  const item = await addNamedItem(LINKS_FILE, title, { url });
  return `Link #${item.id} "${item.title}" tersimpan.`;
}

export async function listNotes() {
  return (await readCollection(NOTES_FILE)).items;
}

export async function listLinks() {
  return (await readCollection(LINKS_FILE)).items;
}

export async function getNote(query) {
  const store = await readCollection(NOTES_FILE);
  return findByIdOrTitle(store, query);
}

export async function getLink(query) {
  const store = await readCollection(LINKS_FILE);
  return findByIdOrTitle(store, query);
}
