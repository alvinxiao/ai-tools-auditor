import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWrite(file, content, exclusive = false) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    if (exclusive) await link(temporary, file);
    else await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function readJson(file) {
  const content = await readFile(file, 'utf8');
  if (Buffer.byteLength(content) > 5_000_000) throw new Error('Input exceeds 5 MB');
  return JSON.parse(content);
}

export async function withCatalog(directory, action) {
  await mkdir(directory, { recursive: true });
  const lock = path.join(directory, 'catalog.lock');
  let handle;
  try { handle = await open(lock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Catalog locked. Stop other commands; after a crash remove catalog.lock manually.'); throw error; }
  try {
    await handle.writeFile(String(process.pid));
    const file = path.join(directory, 'catalog.json');
    let catalog;
    try { catalog = await readJson(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return await action(catalog, async value => atomicWrite(file, JSON.stringify(value, null, 2) + '\n'));
  } finally { await handle.close(); await unlink(lock); }
}
