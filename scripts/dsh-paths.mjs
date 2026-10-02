import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const version = '0.1.7-rc.2';
export const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
export const versionDir = process.env.DSH_VERSION_DIR ?? join(homedir(), '.dsh-win', 'versions', version);
export const store = process.env.DSH_PNPM_STORE ?? join(versionDir, 'node_modules', '.pnpm');

// Inspect physical directories only; do not recursively follow pnpm package links.
export async function installedPackages() {
  const packages = new Map();
  for (const directory of await readdir(store, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const scope = join(store, directory.name, 'node_modules', '@deepseek-ai');
    let children;
    try { children = await readdir(scope, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const manifest = join(scope, child.name, 'package.json');
      const data = JSON.parse(await readFile(manifest, 'utf8'));
      packages.set(data.name, manifest);
    }
  }
  return packages;
}
