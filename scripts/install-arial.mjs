import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
// Upstream Microsoft Core Fonts redistributable; hash from Ubuntu msttcorefonts 3.8.1ubuntu2.
const SHA256 = '85297a4d146e9c87ac6f74822734bdee5f4b2a722d7eaa584b7f2cbf76f478f6';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'data', 'fonts');
if (process.platform === 'win32') {
  await fs.mkdir(target, { recursive: true });
  await fs.copyFile(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'arial.ttf'), path.join(target, 'arial.ttf'));
  console.log('Arial disiapkan dari font Windows yang sudah terpasang.');
  process.exit(0);
}
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'iro-arial-'));
try {
  const response = await fetch('https://downloads.sourceforge.net/corefonts/arial32.exe', { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Font download HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(buffer).digest('hex') !== SHA256) throw new Error('Arial checksum mismatch.');
  const archive = path.join(temp, 'arial32.exe');
  await fs.writeFile(archive, buffer);
  await run('cabextract', ['-q', '-d', temp, archive]);
  await fs.mkdir(target, { recursive: true });
  for (const name of await fs.readdir(temp)) if (/\.ttf$|\.txt$/i.test(name)) await fs.copyFile(path.join(temp, name), path.join(target, name.toLowerCase()));
  // The shared Core Fonts EULA is shipped as licen.txt in the Webdings redistributable.
  const licenseResponse = await fetch('https://downloads.sourceforge.net/corefonts/webdin32.exe', { signal: AbortSignal.timeout(60000) });
  if (!licenseResponse.ok) throw new Error(`License download HTTP ${licenseResponse.status}`);
  const licenseBuffer = Buffer.from(await licenseResponse.arrayBuffer());
  if (createHash('sha256').update(licenseBuffer).digest('hex') !== '64595b5abc1080fba8610c5c34fab5863408e806aafe84653ca8575bed17d75a') throw new Error('Core Fonts license package checksum mismatch.');
  const licenseArchive = path.join(temp, 'webdin32.exe');
  await fs.writeFile(licenseArchive, licenseBuffer);
  const licenseDir = path.join(temp, 'license'); await fs.mkdir(licenseDir);
  await run('cabextract', ['-q', '-d', licenseDir, licenseArchive]);
  const licenseName = (await fs.readdir(licenseDir)).find((name) => name.toLowerCase() === 'licen.txt');
  if (!licenseName) throw new Error('Core Fonts license missing from upstream archive.');
  await fs.copyFile(path.join(licenseDir, licenseName), path.join(target, 'license.txt'));
  const { stdout } = await run('fc-scan', ['--format', '%{family}', path.join(target, 'arial.ttf')]);
  if (!stdout.split(',').map((s) => s.trim()).includes('Arial')) throw new Error('Installed font is not Arial.');
  console.log('Arial siap: data/fonts/arial.ttf (lisensi redistribusi disertakan).');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
