import { DATA_DIR, TELEGRAM_BOT_TOKEN, TELEGRAM_CLIENT_ID, TELEGRAM_PART_SIZE_BYTES } from './config.js';
import { splitBuffer, zipDirectory } from './zip.js';

export async function sendDataBackupToTelegram() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CLIENT_ID) {
    throw new Error('Backup butuh TELEGRAM_BOT_TOKEN dan TELEGRAM_CLIENT_ID di .env.');
  }

  const stamp = backupStamp();
  const zipBuffer = await zipDirectory(DATA_DIR);
  const parts = splitBuffer(zipBuffer, TELEGRAM_PART_SIZE_BYTES);
  const files = parts.map((part, index) => ({
    buffer: part,
    fileName: parts.length === 1 ? `BACKUP-${stamp}.zip` : `PART${index + 1}-${stamp}.zip`
  }));

  for (const file of files) {
    await sendTelegramDocument(file.buffer, file.fileName);
  }

  return files.map((file) => file.fileName);
}

async function sendTelegramDocument(buffer, fileName) {
  const form = new FormData();
  form.append('chat_id', TELEGRAM_CLIENT_ID);
  form.append('document', new Blob([buffer], { type: 'application/zip' }), fileName);
  form.append('caption', `IrOBot data backup: ${fileName}`);

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Telegram backup gagal: HTTP ${response.status}${body ? ` - ${body.slice(0, 300)}` : ''}`);
  }
}

function backupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('_');
}
