// Small helpers so every bot reply looks the same on WhatsApp:
// one status emoji, a bold title, short lines, commands in monospace, hints in italics.

export const ICON = {
  ok: '✅',
  warn: '⚠️',
  fail: '❌',
  wait: '⏳',
  list: '📋',
  info: 'ℹ️',
  key: '🔑',
  tip: '💡'
};

export const bold = (text) => `*${text}*`;
export const italic = (text) => `_${text}_`;
export const cmd = (text) => `\`${text}\``;
export const quote = (text) => String(text).split('\n').map((line) => `> ${line}`).join('\n');
export const title = (icon, text) => `${icon ? `${icon} ` : ''}*${text}*`;
export const line = (label, value) => `• ${label}: ${value}`;
export const hint = (text) => `_${text}_`;

// card({ icon, title, lines, hint }) -> header, blank line, body, blank line, hint.
export function card({ icon = '', title: heading = '', lines = [], hint: footer = '' } = {}) {
  const blocks = [];
  if (heading) blocks.push(title(icon, heading));
  const body = lines.filter((item) => item != null && item !== '').join('\n');
  if (body) blocks.push(body);
  if (footer) blocks.push(hint(footer));
  return blocks.join('\n\n');
}

export function progressBar(percent, size = 8) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((value / 100) * size);
  return `${'▰'.repeat(filled)}${'▱'.repeat(size - filled)}`;
}

// ⏳ *Membuat stiker* ▰▰▰▰▱▱▱▱ 50%
// _Menyusun frame_
export function progress(label, percent, step = '') {
  const value = Math.floor(Math.max(0, Math.min(100, Number(percent) || 0)));
  const head = `${value >= 100 ? ICON.ok : ICON.wait} *${label}* ${progressBar(value)} ${value}%`;
  return step ? `${head}\n${hint(step)}` : head;
}

export const okText = (heading, ...lines) => card({ icon: ICON.ok, title: heading, lines });
export const warnText = (heading, ...lines) => card({ icon: ICON.warn, title: heading, lines });
export const failText = (heading, ...lines) => card({ icon: ICON.fail, title: heading, lines });

const SUBWORDS = 'list|add|del|get|rename|info|session|exit|service|default|key|reset|on|off|here|all|new|except|root|group|local|up|down|save|update|change|wake|stop|pause|resume|record|loop|repeat|every|count|forever|kode|bot|true|false|split|clear|show|set|status|mode|-a|--name|--split|--max-size|--target-size|statussave|backup|logs|changedmsg|errors';
const ARG = String.raw`(?:<[^>\n]+>|\[[^\]\n]+\]|"[^"\n]+"|[\w.#/-]*[=|][\w.#/|%=-]*|\d[\w.:/-]*|(?:${SUBWORDS})(?![\w-]))`;
const INLINE_CMD = new RegExp(String.raw`(^|[\s(“"'/])(,[a-z][a-z0-9]*(?: ${ARG})*)(?=$|[\s.,;:!?)”"'/])`, 'gm');
const LEAD_ICON = /^(\p{Extended_Pictographic}|[*_>•`])/u;

// Puts ",command <args>" fragments in monospace, leaving text already in backticks alone.
export function monoCommands(text) {
  return String(text ?? '').split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => (
    index % 2 ? part : part.replace(INLINE_CMD, (_, lead, command) => `${lead}\`${command}\``)
  )).join('');
}

// A user-facing error: warning icon (unless the text already starts with one) + monospace commands.
export function userErrorText(message) {
  const text = monoCommands(String(message || '').trim());
  if (!text) return `${ICON.warn} Ada yang salah, coba lagi.`;
  return LEAD_ICON.test(text) ? text : `${ICON.warn} ${text}`;
}

const AUTO_ICONS = [
  [/dibatalkan|batal\b/i, '✖️'],
  [/dihapus|dibersihkan/i, '🗑️'],
  [/^(Tidak ada|Belum ada|Tidak tersedia)/i, 'ℹ️'],
  [/^(Menjalankan|Membuat|Mengubah|Mulai|Restart)/i, '⏳'],
  [/dilewati|gagal|tidak dikenal|tidak tersedia/i, '⚠️'],
  [/dibuat|disimpan|tersimpan|ditambahkan|selesai|diaktifkan|dinonaktifkan|dikirim|diterima|diganti|dipulihkan|Keluar dari/i, '✅']
];

// Short bot status line: picks a status emoji from the wording and monospaces commands.
export function botText(text) {
  const value = monoCommands(String(text ?? '').trim());
  if (!value || LEAD_ICON.test(value)) return value;
  const firstLine = value.split('\n')[0];
  const icon = AUTO_ICONS.find(([pattern]) => pattern.test(firstLine))?.[1];
  return icon ? `${icon} ${value}` : value;
}
