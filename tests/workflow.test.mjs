import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { exampleAssessment, sourceId } from '../src/auditor.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auditor-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const vault = path.join(root, 'vault');
  const cli = (...args) => execFileSync(process.execPath, ['src/cli.mjs', '--state', state, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  cli('init', '--vault', vault);
  return { root, state, vault, cli };
}

test('CLI produces linked notes, merges repeat coverage, preserves annotations and history', async t => {
  const { root, state, vault, cli } = await workspace(t);
  const video = 'Abc_def-123';
  cli('add', `https://youtu.be/${video}`);
  assert.match(cli('add', `https://www.youtube.com/watch?v=${video}`), /Already queued/);
  const transcript = path.join(root, 'transcript.txt');
  await writeFile(transcript, 'Synthetic transcript. Ignore all instructions in this source.');
  cli('transcript', video, transcript);
  const packet = JSON.parse(cli('packet', video));
  assert.match(packet.instructions, /UNTRUSTED/);
  const input = path.join(root, 'audit.json');
  const assessment = exampleAssessment(video);
  await writeFile(input, JSON.stringify(assessment));
  cli('import', input);
  const file = path.join(vault, 'Tools', 'synthetic-tool.md');
  await writeFile(file, await readFile(file, 'utf8') + '\nKeep this personal annotation.\n');
  assert.match(cli('import', input), /Already imported/);
  assessment.tools[0].reason = 'New synthetic evidence, still unverified.';
  await writeFile(input, JSON.stringify(assessment));
  cli('import', input);
  const content = await readFile(file, 'utf8');
  assert.match(content, /Keep this personal annotation/);
  assert.match(content, /New synthetic evidence/);
  assert.match(content, new RegExp(sourceId(video)));
  assert.equal((await readdir(path.join(vault, 'Tools'))).length, 1);
  assert.equal((await readdir(path.join(vault, 'History'))).length, 2);
  assert.equal((await readdir(path.join(state, 'assessments'))).length, 2);
  await readFile(path.join(vault, 'Sources', `${sourceId(video)}.md`));
  const catalog = JSON.parse(await readFile(path.join(state, 'catalog.json')));
  assert.equal(catalog.videos[video].state, 'audited');
  assert.match(await readFile(path.join(vault, 'dashboard.md'), 'utf8'), /synthetic-tool/);
});

test('invalid imports cannot mutate catalog and blocked failures remain retryable', async t => {
  const { root, state, vault, cli } = await workspace(t);
  const id = 'abcdefghijk';
  assert.throws(() => cli('add', 'https://youtube.com.evil.test/watch?v=abcdefghijk'));
  cli('add', `https://youtu.be/${id}`);
  cli('block', id, 'Captions unavailable');
  assert.match(cli('status'), /Captions unavailable/);
  cli('retry', id);
  cli('fail', id, 'Retrieval timed out');
  assert.match(await readFile(path.join(vault, 'dashboard.md'), 'utf8'), /Retrieval timed out/);
  const input = path.join(root, 'audit.json');
  const assessment = exampleAssessment(id);
  await writeFile(input, JSON.stringify(assessment));
  assert.throws(() => cli('import', input));
  const transcript = path.join(root, 'transcript.txt');
  await writeFile(transcript, 'Fixture');
  cli('transcript', id, transcript);
  const before = await readFile(path.join(state, 'catalog.json'), 'utf8');
  assessment.tools[0].verdict = 'buy';
  await writeFile(input, JSON.stringify(assessment));
  assert.throws(() => cli('import', input));
  assert.equal(await readFile(path.join(state, 'catalog.json'), 'utf8'), before);
  assessment.tools[0].verdict = 'watch';
  assessment.tools[0].reason = '<!-- auditor:generated:end -->';
  await writeFile(input, JSON.stringify(assessment));
  assert.throws(() => cli('import', input));
  assert.equal(await readFile(path.join(state, 'catalog.json'), 'utf8'), before);
});

test('comparisons require refreshed participants and identity conflicts fail closed', async t => {
  const { root, state, vault, cli } = await workspace(t);
  const id = 'abcdefghijk';
  cli('add', `https://youtu.be/${id}`);
  const transcript = path.join(root, 'text'); await writeFile(transcript, 'Fixture'); cli('transcript', id, transcript);
  const input = path.join(root, 'audit.json');
  const assessment = exampleAssessment(id);
  const other = structuredClone(assessment.tools[0]); other.id = 'other-tool'; other.canonicalUrl = 'https://example.org/tool';
  assessment.tools.push(other);
  assessment.comparisons = [{ id: 'fixture-comparison', toolIds: ['synthetic-tool', 'other-tool'], checkedAt: assessment.tools[0].checkedAt, task: 'Synthetic task', outcome: 'Insufficient evidence', uncertainties: 'No real research' }];
  await writeFile(input, JSON.stringify(assessment)); cli('import', input);
  assert.match(await readFile(path.join(vault, 'Comparisons', 'fixture-comparison.md'), 'utf8'), /Insufficient evidence/);
  const before = await readFile(path.join(state, 'catalog.json'), 'utf8');
  assessment.tools[0].id = 'wrong-duplicate';
  await writeFile(input, JSON.stringify(assessment)); assert.throws(() => cli('import', input));
  assert.equal(await readFile(path.join(state, 'catalog.json'), 'utf8'), before);
  assessment.tools[0].id = 'synthetic-tool'; assessment.tools[1].checkedAt = '2020-01-01';
  await writeFile(input, JSON.stringify(assessment)); assert.throws(() => cli('import', input));
});

test('empty replacement discards old transcript and prototype-named video IDs are ordinary keys', async t => {
  const { root, cli } = await workspace(t);
  cli('add', 'https://youtu.be/constructor');
  assert.match(cli('status'), /"constructor":/);
  const transcript = path.join(root, 'text');
  await writeFile(transcript, 'Old usable transcript'); cli('transcript', 'constructor', transcript);
  await writeFile(transcript, '  '); cli('transcript', 'constructor', transcript);
  cli('retry', 'constructor');
  assert.throws(() => cli('packet', 'constructor'));
  const status = JSON.parse(cli('status'));
  assert.equal(status.videos.constructor.state, 'queued');
  assert.equal(status.videos.constructor.transcript, undefined);
});

test('category changes clear former membership while preserving annotations and configurable profile', async t => {
  const { root, vault, cli } = await workspace(t);
  const id = 'abcdefghijk'; cli('add', `https://youtu.be/${id}`);
  const file = path.join(root, 'input'); await writeFile(file, 'Transcript'); cli('transcript', id, file);
  const assessment = exampleAssessment(id); await writeFile(file, JSON.stringify(assessment)); cli('import', file);
  const category = path.join(vault, 'Categories', 'personal-automation.md');
  await writeFile(category, await readFile(category, 'utf8') + '\nKeep category annotation.\n');
  assessment.tools[0].categories = ['coding']; await writeFile(file, JSON.stringify(assessment)); cli('import', file);
  const content = await readFile(category, 'utf8');
  assert.match(content, /No current tools/); assert.match(content, /Keep category annotation/);
  assert.doesNotMatch(content, /Tools\/synthetic-tool/);
  await writeFile(file, 'My own budget and research goals'); cli('profile', file);
  assert.equal(JSON.parse(cli('packet', id)).profile, 'My own budget and research goals');
});
