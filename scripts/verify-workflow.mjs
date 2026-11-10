import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';
import { exampleAssessment, sourceId } from '../src/auditor.mjs';

const root = path.resolve('verification/workflow');
await mkdir(root, { recursive: true });
const state = path.join(root, 'state');
const vault = path.join(root, 'vault');
const cli = (...args) => main(['--state', state, ...args]);
try { await readFile(path.join(state, 'catalog.json')); }
catch (error) { if (error.code !== 'ENOENT') throw error; await cli('init', '--vault', vault); }
const id = 'abcdefghijk';
await cli('add', `https://youtu.be/${id}`);
const transcript = path.join(root, 'transcript.txt');
await writeFile(transcript, 'Synthetic fixture only. No actual product assertions.');
await cli('transcript', id, transcript);
await cli('packet', id, path.join(root, 'packet.json'));
const input = path.join(root, 'assessment.json');
await writeFile(input, JSON.stringify(exampleAssessment(id), null, 2));
await cli('import', input);
const note = path.join(vault, 'Tools', 'synthetic-tool.md');
let content = await readFile(note, 'utf8');
if (!content.includes('Preserve my annotation.')) await writeFile(note, content + '\nPreserve my annotation.\n');
await cli('render');
content = await readFile(note, 'utf8');
assert.match(content, /Preserve my annotation/);
assert.match(content, /Verdict: watch/);
await readFile(path.join(vault, 'Sources', `${sourceId(id)}.md`));
await readFile(path.join(vault, 'Categories', 'personal-automation.md'));
assert.match(await readFile(path.join(vault, 'dashboard.md'), 'utf8'), /Needs evidence/);
console.log(`PASS: CLI queue, packet, validated import, links, annotations, dashboard. Synthetic vault: ${vault}`);
