import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export async function directoryBytes(root: string): Promise<number> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink()) return 0;
  if (info.isFile()) return info.size;
  let total = 0;
  for (const name of await readdir(root).catch(() => [])) total += await directoryBytes(path.join(root, name));
  return total;
}
/** Only content-addressed entries owned by this application may be removed. */
export async function collectCache(root: string, hashes: Set<string>): Promise<number> {
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return 0;
  const canonical = await realpath(root);
  let removed = 0;
  async function sweep(directory: string, sources: boolean) {
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = sources ? /^([a-f0-9]{64})\.[a-zA-Z0-9]+$/.exec(entry.name) : /^([a-f0-9]{64})$/.exec(entry.name);
      if (!match || hashes.has(match[1]!) || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      const resolved = await realpath(target).catch(() => '');
      if (!resolved.startsWith(canonical + path.sep)) continue;
      try { await rm(target, { recursive: true }); removed++; } catch { /* In-use files are retried on the next idle scan. */ }
    }
  }
  await sweep(path.join(root, 'sources'), true);
  await sweep(root, false);
  return removed;
}
