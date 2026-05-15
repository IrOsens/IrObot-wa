import fs from 'node:fs/promises';
import path from 'node:path';

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
const DEFAULT_EXPIRES = 2147483647;

export function normalizeYoutubeCookies(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Cookies kosong.');
  if (looksLikeJson(text)) return cookieJsonToNetscape(text);
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
    'Paste cookies JSON export browser, isi cookies.txt Netscape, atau raw header Cookie: di pesan berikutnya.',
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

function looksLikeJson(text) {
  return /^[\[{]/.test(String(text || '').trim());
}

function cookieJsonToNetscape(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Format cookies JSON tidak valid.');
  }

  const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(cookies) || !cookies.length) {
    throw new Error('Format cookies JSON tidak dikenali. Pastikan ada array "cookies".');
  }

  const lines = cookies
    .map(cookieJsonLine)
    .filter(Boolean);
  if (!lines.length) throw new Error('Cookies JSON tidak berisi cookie yang valid.');
  return [NETSCAPE_HEADER, ...lines].join('\n');
}

function cookieJsonLine(cookie) {
  if (!cookie || typeof cookie !== 'object') return null;
  const name = cleanCookieField(cookie.name);
  if (!name) return null;
  const value = cleanCookieField(cookie.value ?? '');
  const rawDomain = cleanDomain(cookie.domain);
  const domain = rawDomain || '.youtube.com';
  const includeSubdomains = cookie.hostOnly === false || domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const pathValue = cleanCookieField(cookie.path || '/');
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  const expires = normalizeExpires(cookie.expirationDate ?? cookie.expires ?? cookie.expiry);
  const domainCell = cookie.httpOnly ? `#HttpOnly_${domain}` : domain;
  return [domainCell, includeSubdomains, pathValue || '/', secure, expires, name, value].join('\t');
}

function cleanDomain(value) {
  const domain = String(value || '').trim();
  if (!domain) return '';
  const normalized = domain.replace(/^https?:\/\//i, '').split('/')[0];
  return /^#?\.?[\w.-]+$/.test(normalized) ? normalized.replace(/^#HttpOnly_/i, '') : '';
}

function normalizeExpires(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_EXPIRES;
  return String(Math.floor(number));
}

function cleanCookieField(value) {
  return String(value ?? '')
    .replace(/\t/g, '%09')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
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
    throw new Error('Format cookies tidak dikenali. Kirim JSON export browser, cookies.txt Netscape, atau raw header Cookie:.');
  }

  return [
    NETSCAPE_HEADER,
    ...pairs.map(([name, value]) => ['.youtube.com', 'TRUE', '/', 'TRUE', DEFAULT_EXPIRES, name, value].join('\t'))
  ].join('\n');
}
