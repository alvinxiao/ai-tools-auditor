import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './store.mjs';

const START = '<!-- auditor:generated:start -->';
const END = '<!-- auditor:generated:end -->';

// The caller supplies a stable product ID; display names may change independently.
export async function writeToolReport(vault, { id, title, body }) {
  return writeGeneratedNote(path.join(vault, 'Tools'), { id, title, body });
}

export async function writeGeneratedNote(folder, { id, title, body }) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error('Tool ID must contain lowercase letters, digits, and separating hyphens');
  }
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) {
    throw new Error('Report title must be a nonempty single line');
  }
  if (typeof body !== 'string' || !body.trim() ||
      [START, END].some(marker => body.includes(marker) || title.includes(marker))) {
    throw new Error('Report body must be nonempty and contain no section markers');
  }
  const file = path.join(folder, `${id}.md`);
  const generated = `${START}\n# ${title}\n\n${body.trim()}\n${END}`;
  let existing;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let content;
  if (existing === undefined) {
    content = `${generated}\n\n## Personal notes\n\n`;
  } else {
    if (existing.split(START).length !== 2 || existing.split(END).length !== 2 ||
        existing.indexOf(END) < existing.indexOf(START)) {
      throw new Error(`Cannot refresh ${id}: generated section markers are missing or ambiguous`);
    }
    content = existing.slice(0, existing.indexOf(START)) + generated +
      existing.slice(existing.indexOf(END) + END.length);
  }
  await mkdir(folder, { recursive: true });
  await atomicWrite(file, content, existing === undefined);
  return file;
}
