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
  if (!command.args.length || command.args[0].toLowerCase() === 'list') {
    return formatNamedList(await listNotes(file), 'Belum ada note.');
  }
  const action = command.args[0].toLowerCase();
  if (action === 'rename' || action === 'change') {
    const query = command.args[1];
    const newTitle = command.args.slice(2).join(' ').trim();
    if (!query || !newTitle) throw new Error(noteFormat());
    const item = await renameNamedItem(file, query, newTitle, 'Note');
    return `Note #${item.id} diganti judul menjadi "${item.title}".`;
  }
  if (action === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error(noteFormat());
    const item = await deleteNamedItem(file, query, 'Note');
    return `Note #${item.id} "${item.title}" dihapus.`;
  }
  if (action === 'get') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error(noteFormat());
    const item = await getNote(query, file);
    if (!item) throw new Error(`Note "${query}" tidak ditemukan.\n\n${noteFormat()}`);
    return `#${item.id} - ${item.title}\n${item.text}`;
  }
  if (action === 'add') {
    const title = command.args[1];
    const text = command.args.slice(2).join(' ').trim();
    if (!title || !text) throw new Error(noteFormat());
    const item = await addNamedItem(file, title, { text });
    return `Note #${item.id} "${item.title}" tersimpan.`;
  }
  if (['delete', 'remove', 'rm'].includes(action)) throw new Error(noteFormat());
  if (command.args.length === 1) {
    const item = await getNote(command.args[0], file);
    if (!item) throw new Error(`Note "${command.args[0]}" tidak ditemukan.\n\n${noteFormat()}`);
    return `#${item.id} - ${item.title}\n${item.text}`;
  }

  const title = command.args[0];
  const text = command.args.slice(1).join(' ').trim();
  if (!text) throw new Error(noteFormat());
  const item = await addNamedItem(file, title, { text });
  return `Note #${item.id} "${item.title}" tersimpan.`;
}

export async function handleLinkCommand(command, file = LINKS_FILE) {
  if (!command.args.length || command.args[0].toLowerCase() === 'list') {
    return formatNamedList(await listLinks(file), 'Belum ada link.');
  }
  const action = command.args[0].toLowerCase();
  if (action === 'rename' || action === 'change') {
    const query = command.args[1];
    const newTitle = command.args.slice(2).join(' ').trim();
    if (!query || !newTitle) throw new Error(linkFormat());
    const item = await renameNamedItem(file, query, newTitle, 'Link');
    return `Link #${item.id} diganti nama menjadi "${item.title}".`;
  }
  if (action === 'del') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error(linkFormat());
    const item = await deleteNamedItem(file, query, 'Link');
    return `Link #${item.id} "${item.title}" dihapus.`;
  }
  if (action === 'get') {
    const query = command.args.slice(1).join(' ').trim();
    if (!query) throw new Error(linkFormat());
    const item = await getLink(query, file);
    if (!item) throw new Error(`Link "${query}" tidak ditemukan.\n\n${linkFormat()}`);
    return `#${item.id} - ${item.title}\n${item.url}`;
  }
  if (action === 'add') {
    const title = command.args[1];
    const url = command.args[2];
    if (!title || !LINK_RE.test(url || '')) throw new Error(linkFormat());
    const item = await addNamedItem(file, title, { url });
    return `Link #${item.id} "${item.title}" tersimpan.`;
  }
  if (['delete', 'remove', 'rm'].includes(action)) throw new Error(linkFormat());
  if (command.args.length === 1) {
    const item = await getLink(command.args[0], file);
    if (!item) throw new Error(`Link "${command.args[0]}" tidak ditemukan.\n\n${linkFormat()}`);
    return `#${item.id} - ${item.title}\n${item.url}`;
  }

  const title = command.args[0];
  const url = command.args[1];
  if (!LINK_RE.test(url || '')) throw new Error(linkFormat());
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

function noteFormat() {
  return [
    'Format note:',
    ',note list',
    ',note add <judul> <teks>',
    ',note get <id|judul>',
    ',note del <id|judul>',
    ',note rename <id|judul> <judul-baru>'
  ].join('\n');
}

function linkFormat() {
  return [
    'Format link:',
    ',link list',
    ',link add <nama> <https://link>',
    ',link get <id|nama>',
    ',link del <id|nama>',
    ',link rename <id|nama> <nama-baru>'
  ].join('\n');
}
