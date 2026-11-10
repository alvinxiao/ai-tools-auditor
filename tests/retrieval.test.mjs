import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseCaptions, retrievalArgs, retrieveTranscript } from '../src/retrieval.mjs';

test('JSON3 caption parsing joins segments and removes repeated caption lines', () => {
  assert.equal(parseCaptions(JSON.stringify({ events: [
    { segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
    { segs: [{ utf8: 'Hello world' }] }, { segs: [{ utf8: '\n' }] },
    { segs: [{ utf8: 'Next caption.' }] },
  ] })), 'Hello world\nNext caption.');
  assert.equal(parseCaptions('{"events":[]}'), '');
  assert.throws(() => parseCaptions('{"events":[{"segs":[{"utf8":4}]}]}'));
  assert.throws(() => parseCaptions('x'.repeat(2_000_001)), /exceed/);
});

test('retrieval mounts only scratch and a read-only artifact and disables automatic loading', () => {
  const artifact = path.resolve('runtime/yt-dlp');
  const scratch = path.resolve('scratch');
  const args = retrievalArgs({ id: 'abcdefghijk', artifact, scratch, image: 'sha256:' + 'a'.repeat(64), name: 'test-container' });
  const mounts = args.flatMap((value, index) => value === '--mount' ? [args[index + 1]] : []);
  assert.deepEqual(mounts, [
    `type=bind,source=${artifact},target=/runtime/yt-dlp,readonly`,
    `type=bind,source=${scratch},target=/output`,
  ]);
  for (const flag of ['--ignore-config', '--no-plugin-dirs', '--no-remote-components', '--no-cache-dir', '--skip-download', '--read-only']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
  assert.equal(args[args.indexOf('--pull') + 1], 'never');
  assert.equal(args[args.indexOf('--sub-langs') + 1], 'en-orig,en');
  assert.equal(args[args.indexOf('--extractor-args') + 1], 'youtube:skip=translated_subs');
  const customUser = retrievalArgs({ id: 'abcdefghijk', artifact, scratch, image: 'sha256:' + 'a'.repeat(64), name: 'test-container', user: '1234:2345' });
  assert.equal(customUser[customUser.indexOf('--user') + 1], '1234:2345');
  for (const user of ['0:1000', '1000:0', 'root', '-1:1000']) {
    assert.throws(() => retrievalArgs({ id: 'abcdefghijk', artifact, scratch, image: 'sha256:' + 'a'.repeat(64), name: 'test-container', user }), /non-root/);
  }
  assert.ok(!args.some(value => /cookies|exec|docker\.sock/.test(value) && !['/tmp:rw,noexec,nosuid,size=32m'].includes(value)));
  assert.throws(() => retrievalArgs({ id: '../outside', artifact, scratch, image: 'sha256:' + 'a'.repeat(64) }), /video ID/);
});

test('unverified artifact fails before invoking Docker', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auditor-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = path.join(root, 'yt-dlp');
  await writeFile(artifact, 'not a verified executable');
  const result = await retrieveTranscript('abcdefghijk', { artifact, image: 'reviewed-image' });
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /digest mismatch/);
  assert.equal(result.transcript, undefined);
});

test('CLI records retrieval configuration failure and discards obsolete transcript', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auditor-retrieval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const cli = (...args) => execFileSync(process.execPath, ['src/cli.mjs', '--state', state, ...args], {
    encoding: 'utf8', env: { ...process.env, AUDITOR_RETRIEVAL_IMAGE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  cli('init', '--vault', path.join(root, 'vault'));
  cli('add', 'https://youtu.be/abcdefghijk');
  const transcript = path.join(root, 'old.txt');
  await writeFile(transcript, 'Old transcript');
  cli('transcript', 'abcdefghijk', transcript);
  cli('retrieve', 'abcdefghijk');
  const catalog = JSON.parse(await readFile(path.join(state, 'catalog.json'), 'utf8'));
  assert.equal(catalog.videos.abcdefghijk.state, 'failed');
  assert.equal(catalog.videos.abcdefghijk.transcript, undefined);
  assert.match(catalog.videos.abcdefghijk.reason, /AUDITOR_RETRIEVAL_IMAGE/);
  assert.throws(() => cli('packet', 'abcdefghijk'));
  catalog.videos.abcdefghijk.state = 'blocked';
  catalog.videos.abcdefghijk.retrieval.retryAfter = new Date(Date.now() + 15 * 60_000).toISOString();
  const file = path.join(state, 'catalog.json');
  await writeFile(file, JSON.stringify(catalog));
  const before = await readFile(file, 'utf8');
  assert.match(cli('retrieve', 'abcdefghijk'), /Rate limited/);
  assert.equal(await readFile(file, 'utf8'), before);
});
