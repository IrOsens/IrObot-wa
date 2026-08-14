import { jidNormalizedUser } from 'baileys';

export function normalizePhoneNumber(input) {
  const raw = String(input || '').trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) throw new Error('Nomor telepon wajib diisi.');

  let phone = digits;
  if (phone.startsWith('0')) phone = `62${phone.slice(1)}`;
  else if (phone.startsWith('8')) phone = `62${phone}`;

  if (!/^\d{8,20}$/.test(phone)) {
    throw new Error('Nomor telepon tidak valid. Gunakan 8-20 digit, misalnya 08123431212, +62 123-1234-1234, atau +62 123-1234-1234-1234.');
  }
  return phone;
}

export function normalizePhoneToJid(input) {
  if (String(input || '').includes('@')) return normalizeJid(input);
  return `${normalizePhoneNumber(input)}@s.whatsapp.net`;
}

export function tryNormalizePhoneToJid(input) {
  try {
    return normalizePhoneToJid(input);
  } catch {
    return null;
  }
}

export function normalizeJid(input) {
  const jid = String(input || '').trim();
  if (!jid) throw new Error('JID tidak valid.');
  return jidNormalizedUser(jid);
}

export function sameJid(a, b) {
  const left = tryNormalizeJid(a);
  const right = tryNormalizeJid(b);
  return Boolean(left && right && left === right);
}

export function tryNormalizeJid(input) {
  try {
    return normalizeJid(input);
  } catch {
    return null;
  }
}

export function displayPhoneFromJid(jid) {
  const normalized = tryNormalizeJid(jid) || String(jid || '');
  return normalized.split('@')[0] || normalized;
}
