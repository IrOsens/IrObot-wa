import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
for (const dir of ['src', 'scripts']) {
  for (const name of await fs.readdir(dir)) if (/\.m?js$/.test(name)) execFileSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
}
