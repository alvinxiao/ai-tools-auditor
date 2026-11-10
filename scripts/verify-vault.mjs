import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { writeToolReport } from '../src/vault.mjs';

const vault = path.resolve('verification/vault');
await mkdir(path.join(vault, 'Sources'), { recursive: true });
await writeFile(path.join(vault, 'Sources', 'sample-video.md'),
  '# Sample source\n\nSynthetic verification fixture; not a video audit.\n');
const report = { id: 'example-tool', title: 'Example Tool (test fixture)',
  body: 'Synthetic fixture, not an audited recommendation.\n\nVerdict: watch\n\n[Source](../Sources/sample-video.md)' };
const file = await writeToolReport(vault, report);
const annotation = 'Verification annotation: preserve this note.';
let content = await readFile(file, 'utf8');
if (!content.includes(annotation)) await writeFile(file, content + annotation + '\n');
await writeToolReport(vault, { ...report, body: report.body.replace('Verdict: watch', 'Verdict: adapt') });
content = await readFile(file, 'utf8');
assert.ok(content.includes(annotation));
assert.ok(content.includes('Verdict: adapt'));
assert.ok(!content.includes('Verdict: watch'));
await readFile(path.resolve(path.dirname(file), '../Sources/sample-video.md'), 'utf8');
await writeFile(path.join(vault, 'Dashboard.md'), '# Verification vault\n\nSynthetic fixtures only.\n\n[Example tool](Tools/example-tool.md)\n');
console.log('PASS: refreshed report, preserved annotation, and resolved source link.');
console.log(`Test vault: ${vault}`);
