// Optional download of exact upstream packages into ignored local audit data.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { version } from './dsh-paths.mjs';

const packages = [
  ['profile', 'agent-team-profile', '1df85943871e0a0e90aee8475b56c31c456bf65d'],
  ['service', 'agent-team', '742d186c32337e01cc9194883fb1acbf45b75313'],
  ['tools', 'tool-agent-team', 'a189508c65cc026d49c6770d1350511dc5ce2e4b'],
];
const audit = resolve('.state/team-package-audit');
await mkdir(audit, { recursive: true });
for (const [kind, stem, expected] of packages) {
  const name = `@deepseek-ai/dsh-experimental-${stem}`;
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Registry returned ${response.status}: ${name}`);
  const manifest = await response.json();
  if (manifest.name !== name || manifest.version !== version || manifest.dist?.shasum !== expected) throw new Error(`Unexpected package identity: ${name}`);
  const url = new URL(manifest.dist.tarball);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') throw new Error('Unexpected tarball host');
  const archiveResponse = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!archiveResponse.ok) throw new Error(`Tarball returned ${archiveResponse.status}: ${name}`);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  if (createHash('sha1').update(bytes).digest('hex') !== expected) throw new Error(`Tarball checksum mismatch: ${name}`);
  const archive = join(audit, `deepseek-ai-dsh-experimental-${stem}-${version}.tgz`);
  await writeFile(archive, bytes);
  const target = join(audit, kind);
  await mkdir(target, { recursive: true });
  await promisify(execFile)('tar', ['-xzf', archive, '-C', target], { windowsHide: true });
  console.log(`Prepared ${name}@${version}`);
}
