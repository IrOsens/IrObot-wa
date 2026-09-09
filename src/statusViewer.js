import fs from 'node:fs/promises';
import path from 'node:path';
import { mediaNode, downloadMessageMedia, cleanupFiles } from './media.js';
import { reviveValue } from './recordedMessages.js';
import { getMessageText } from './text.js';
import { safeComponent, wibDay } from './storage.js';
import { UserInputError } from './errors.js';

export function statusCaption(message) {
  return getMessageText(message) || String(mediaNode(message)?.node?.caption || '');
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function archivedMedia(item, message, root) {
  if (!root) return null;
  const found = mediaNode(message);
  if (!found) return null;
  try {
    const realRoot = await fs.realpath(root);
    let manifest = item.archives?.[`local:${root}`]?.path;
    if (!manifest) {
      const folders = JSON.parse(await fs.readFile(path.join(root, '.folders.json'), 'utf8'));
      const folder = folders[item.author];
      if (!folder) return null;
      const stamp = new Date(item.timestamp + 7 * 3600000).toISOString().slice(11, 19).replaceAll(':', '-');
      manifest = path.join(root, folder, wibDay(item.timestamp), `${stamp}-${safeComponent(message.key.id)}.json`);
    }
    const realManifest = await fs.realpath(manifest);
    if (!inside(realRoot, realManifest)) throw new Error('Referensi arsip status berada di luar tujuan lokal.');
    const metadata = JSON.parse(await fs.readFile(realManifest, 'utf8'));
    if (metadata.identity !== item.author || metadata.sourceKey?.id !== message.key.id) throw new Error('Identitas arsip status tidak cocok.');
    if (!metadata.mediaPath) return null;
    const file = await fs.realpath(metadata.mediaPath);
    if (!inside(realRoot, file)) throw new Error('Media arsip berada di luar tujuan lokal.');
    return { path: file, type: found.type, node: found.node, mimetype: found.node.mimetype, fileName: found.node.fileName };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Preview is deliberately independent from archival receipts: the owner can view repeatedly.
export async function presentStatus(item, {
  sock, localRoot, maxMediaBytes, sendText, sendMedia,
  now = () => Date.now(), download = downloadMessageMedia
}) {
  if (!item || item.deleted || item.expiresAt <= now()) return 'expired';
  const message = reviveValue(item.message);
  const caption = statusCaption(message);
  if (!mediaNode(message)) {
    await sendText(caption);
    return 'success';
  }
  let media = await archivedMedia(item, message, localRoot);
  const temporary = !media;
  try {
    if (!media) {
      if (Number(mediaNode(message).node.fileLength || 0) > maxMediaBytes) throw new UserInputError('Media status melebihi batas ukuran.');
      media = await download(sock, message, 'status-preview');
    }
    if (!media) throw new Error('Media status tidak tersedia.');
    if ((await fs.stat(media.path)).size > maxMediaBytes) throw new UserInputError('Media status melebihi batas ukuran.');
    if (item.expiresAt <= now()) return 'expired';
    if (caption && !['imageMessage', 'videoMessage'].includes(media.type)) await sendText(caption);
    await sendMedia(media, caption);
    return 'success';
  } finally { if (temporary) await cleanupFiles([media?.path]); }
}
