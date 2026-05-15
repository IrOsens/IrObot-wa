import fs from 'node:fs/promises';
import path from 'node:path';

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
const DEFAULT_EXPIRES = 2147483647;

export function normalizeYoutubeCookies(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Cookies kosong.');
  if (isNetscapeCookieText(text)) return ensureNetscapeHeader(text);
  return cookieHeaderToNetscape(text);
}

export async function saveYoutubeCookies(input, filePath) {
  const normalized = normalizeYoutubeCookies(input);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${normalized.replace(/\s+$/g, '')}\n`, { mode: 0o600 });
  return filePath;
}

export async function hasYoutubeCookies(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function youtubeCookiePrompt() {
  return [
    'YouTube butuh cookies untuk video ini.',
    'Paste isi cookies.txt Netscape atau raw header Cookie: dari browser di pesan berikutnya.',
    'Ketik ,cancel untuk batal.'
  ].join('\n');
}

export function isYoutubeCookieNeededError(error) {
  return error?.code === 'YOUTUBE_COOKIES_NEEDED' || error?.needsYoutubeCookies === true;
}

function isNetscapeCookieText(text) {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || (trimmed.startsWith('#') && !trimmed.startsWith('#HttpOnly_'))) return false;
    const parts = trimmed.split('\t');
    const domain = String(parts[0] || '').replace(/^#HttpOnly_/i, '');
    return parts.length >= 7 && /^\.?[\w.-]+$/.test(domain);
  });
}

function ensureNetscapeHeader(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  if (lines.some((line) => line.includes('Netscape HTTP Cookie File'))) return lines.join('\n');
  return [NETSCAPE_HEADER, ...lines].join('\n');
}

function cookieHeaderToNetscape(input) {
  const header = input
    .replace(/^cookie\s*:\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ');

  const pairs = header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      if (index <= 0) return null;
      return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    })
    .filter(Boolean)
    .filter(([name]) => !/^(\$|path$|domain$|expires$|max-age$|secure$|httponly$|samesite$)/i.test(name));

  if (!pairs.length) {
    throw new Error('Format cookies tidak dikenali. Kirim cookies.txt Netscape atau raw header Cookie:.');
  }

  return [
    NETSCAPE_HEADER,
    ...pairs.map(([name, value]) => ['.youtube.com', 'TRUE', '/', 'TRUE', DEFAULT_EXPIRES, name, value].join('\t'))
  ].join('\n');
}
