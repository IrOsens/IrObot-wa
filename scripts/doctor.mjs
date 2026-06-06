import { detectTools } from '../src/tools.js';
import { APP_CONFIG, BACKUP_PART_SIZE_BYTES } from '../src/config.js';
import { formatBytes } from '../src/tools.js';

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function line(label, value) {
  console.log(`${label}: ${value}`);
}

async function main() {
  const tools = await detectTools();

  line('Platform', `${process.platform} ${process.arch}`);
  line('Node', process.version);
  line('ffmpeg', tools.ffmpeg || 'missing');
  line('ffprobe', tools.ffprobe || 'missing');
  line('LibreOffice/soffice', tools.office || 'missing');
  line('Target primary group', APP_CONFIG.targets?.primaryGroup || 'missing');
  line('Backup destination default', APP_CONFIG.destinations?.backup || 'backup');
  line('Backup part size', formatBytes(BACKUP_PART_SIZE_BYTES));
  console.log('');
  line('Full sticker/media support', yesNo(Boolean(tools.ffmpeg)));
  line('Office to PDF support', yesNo(Boolean(tools.office)));
  console.log('');

  if (!tools.ffmpeg || !tools.ffprobe || !tools.office) {
    console.log('Ada tool opsional yang belum tersedia. Jalankan `npm run setup:full` untuk mencoba install otomatis.');
    process.exitCode = 1;
    return;
  }

  console.log('Semua tool opsional terdeteksi. Fitur penuh siap dipakai.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
