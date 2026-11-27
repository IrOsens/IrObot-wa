import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
// Upstream Microsoft Core Fonts redistributable; hash from Ubuntu msttcorefonts 3.8.1ubuntu2.
const ARIAL_SHA256 = '85297a4d146e9c87ac6f74822734bdee5f4b2a722d7eaa584b7f2cbf76f478f6';
// Impact.TTF checksum from Debian msttcorefonts 3.8.1.
const IMPACT_SHA256 = '00f1fc230ac99f9b97ba1a7c214eb5b909a78660cb3826fca7d64c3af5a14848';
const impactOnly = process.argv.includes('--impact-only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'data', 'fonts');
if (process.platform === 'win32') {
  await fs.mkdir(target, { recursive: true });
  const windowsFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  for (const font of impactOnly ? ['impact.ttf'] : ['arial.ttf', 'impact.ttf']) {
    await fs.copyFile(path.join(windowsFonts, font), path.join(target, font));
  }
  console.log('Font disiapkan dari Windows.');
  process.exit(0);
}
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'iro-corefonts-'));
async function extractArchive(name, destination, checksum) {
  const response = await fetch(`https://downloads.sourceforge.net/corefonts/${name}`, {
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(buffer).digest('hex') !== checksum) {
    throw new Error(`${name}: checksum mismatch`);
  }
  const archive = path.join(temp, name);
  await fs.writeFile(archive, buffer);
  await fs.mkdir(destination, { recursive: true });
  await run('cabextract', ['-q', '-d', destination, archive]);
}

try {
  const impact = path.join(temp, 'impact');
  // This archive is extracted as data and its executable is never run.
  await extractArchive('impact32.exe', impact, '6061ef3b7401d9642f5dfdb5f2b376aa14663f6275e60a51207ad4facf2fccfb');
  const impactName = (await fs.readdir(impact)).find((name) => name.toLowerCase() === 'impact.ttf');
  if (!impactName) throw new Error('Impact.TTF tidak ditemukan di arsip.');
  const impactPath = path.join(impact, impactName);
  if (createHash('sha256').update(await fs.readFile(impactPath)).digest('hex') !== IMPACT_SHA256) {
    throw new Error('Impact.TTF checksum mismatch');
  }

  await fs.mkdir(target, { recursive: true });
  const licensePath = path.join(target, 'license.txt');
  const hasLicense = await fs.access(licensePath).then(() => true, () => false);
  if (!hasLicense) {
    const license = path.join(temp, 'license');
    await extractArchive('webdin32.exe', license, '64595b5abc1080fba8610c5c34fab5863408e806aafe84653ca8575bed17d75a');
    const licenseName = (await fs.readdir(license)).find((name) => name.toLowerCase() === 'licen.txt');
    if (!licenseName) throw new Error('Core Fonts license missing from upstream archive.');
    await fs.copyFile(path.join(license, licenseName), licensePath);
  }
  await fs.copyFile(impactPath, path.join(target, 'impact.ttf'));
  console.log('Impact siap: data/fonts/impact.ttf.');

  if (!impactOnly) {
    const arial = path.join(temp, 'arial');
    await extractArchive('arial32.exe', arial, ARIAL_SHA256);
    for (const name of await fs.readdir(arial)) {
      if (/\.ttf$/i.test(name)) await fs.copyFile(path.join(arial, name), path.join(target, name.toLowerCase()));
    }
    const { stdout } = await run('fc-scan', ['--format', '%{family}', path.join(target, 'arial.ttf')]);
    if (!stdout.split(',').map((family) => family.trim()).includes('Arial')) throw new Error('Installed font is not Arial.');
    console.log('Arial siap: data/fonts/arial.ttf.');
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
