import fs from 'node:fs/promises';
import path from 'node:path';

export async function assertLocalTarget(file, root) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Target escapes the approved directory.');
  let current = path.resolve(root);
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Reparse/symbolic links are not permitted in managed storage.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path.resolve(file);
}
