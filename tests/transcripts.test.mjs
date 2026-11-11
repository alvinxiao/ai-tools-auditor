import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseHtmlTranscript } from '../src/transcripts.mjs';

const SEGMENT = body => `<transcript-segment-view-model><span role="text">${body}</span></transcript-segment-view-model>`;
const LEGACY = body => `<ytd-transcript-segment-renderer><div class="segment-text"><yt-formatted-string>${body}</yt-formatted-string></div></ytd-transcript-segment-renderer>`;

test('modern segments extract nested span text, normalize whitespace, decode entities, keep order', () => {
  const html = `<!doctype html><html><body>${
    SEGMENT('Hello <span>world </span>&amp; friends')
  }${SEGMENT('Tom &#39;s &#x27;second&#39; &lt;line&gt;')}${
    LEGACY('Legacy line')
  }${SEGMENT('  spaced\t\n  out  ')}</body></html>`;
  assert.equal(parseHtmlTranscript(html), 'Hello world & friends\nTom \'s \'second\' <line>\nLegacy line\nspaced out');
});

test('script, style, and comment content is skipped including fake embedded segments', () => {
  const fake = '<transcript-segment-view-model><span role="text">fake segment</span></transcript-segment-view-model>';
  const html = `<!doctype html><html><head><style>.x{color:red} fake style ${fake}</style></head><body><!-- fake ${fake} --><script>var f="${fake}"; if (1<2) alert(f);</script>${
    SEGMENT('Real line.')}</body></html>`;
  assert.equal(parseHtmlTranscript(html), 'Real line.');
});

test('legacy renderer without yt-formatted-string falls back to segment text element', () => {
  const html = `<ytd-transcript-segment-renderer><div class="segment-text other">Plain <b>bold</b> text</div></ytd-transcript-segment-renderer>`;
  assert.equal(parseHtmlTranscript(html), 'Plain bold text');
});

test('truncated or malformed segments are rejected, not partially extracted', () => {
  assert.throws(() => parseHtmlTranscript(`<html><body>${SEGMENT('Good.')}<transcript-segment-view-model><span role="text">cut off</span>`), /unclosed/);
  assert.throws(() => parseHtmlTranscript(`${SEGMENT('Good.')}<transcript-segment-view-model>`), /unclosed/);
  assert.throws(() => parseHtmlTranscript(SEGMENT('unbalanced <span>nested')), /unclosed/);
  assert.throws(() => parseHtmlTranscript('<transcript-segment-view-model><b>no text span</b></transcript-segment-view-model>'), /no <span role="text">/);
  assert.throws(() => parseHtmlTranscript('<ytd-transcript-segment-renderer><p>no segment text</p></ytd-transcript-segment-renderer>'), /no .segment-text/);
  assert.throws(() => parseHtmlTranscript('Hello <!-- unterminated comment'), /unterminated comment/);
  assert.throws(() => parseHtmlTranscript(`${SEGMENT('Good.')}<script>var x = "never closed`), /unclosed/);
});

test('well-formed HTML without segments yields empty transcript; oversize input is rejected', () => {
  assert.equal(parseHtmlTranscript('<html><body><p>No transcript here.</p></body></html>'), '');
  assert.throws(() => parseHtmlTranscript('a'.repeat(5_000_001)), /exceeds 5 MB/);
  assert.throws(() => parseHtmlTranscript(SEGMENT('a'.repeat(2_000_001))), /exceeds 2 MB/);
  assert.equal(parseHtmlTranscript(SEGMENT('a'.repeat(2_000_000))), 'a'.repeat(2_000_000));
});

function workspace(t) {
  return mkdtemp(path.join(os.tmpdir(), 'auditor-transcripts-')).then(root => {
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = path.join(root, 'state');
    const cli = (...args) => execFileSync(process.execPath, ['src/cli.mjs', '--state', state, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cli('init', '--vault', path.join(root, 'vault'));
    return { root, state, cli, catalog: () => readFile(path.join(state, 'catalog.json'), 'utf8') };
  });
}

test('CLI explicit HTML import becomes ready, records provenance, clears retrieval staleness, exports packet', async t => {
  const { root, cli, catalog } = await workspace(t);
  const id = 'abcdefghijk';
  cli('add', `https://youtu.be/${id}`);
  await writeFile(path.join(root, 'note.txt'), 'placeholder');
  cli('transcript', id, path.join(root, 'note.txt'));
  await writeFile(path.join(root, 'note.txt'), '');
  cli('transcript', id, path.join(root, 'note.txt'));
  const file = path.join(root, 'page.txt');
  await writeFile(file, `<html><body>${SEGMENT('Imported from saved page. &amp; entity')} ${LEGACY('Legacy line too.')}</body></html>`);
  cli('transcript', id, file, '--format', 'html');
  const data = JSON.parse(await catalog());
  const video = data.videos[id];
  assert.equal(video.state, 'ready');
  assert.equal(video.transcript, 'Imported from saved page. & entity\nLegacy line too.');
  assert.equal(video.provenance.method, 'supplied-html');
  assert.ok(video.provenance.importedAt);
  assert.equal(video.retrieval?.retryAfter, undefined);
  assert.equal(video.retrieval?.warning, undefined);
  assert.ok(!JSON.stringify(video).includes(root));
  cli('retry', id);
  assert.equal(JSON.parse(await catalog()).videos[id].state, 'ready');
  const packetFile = path.join(root, 'packet.json');
  cli('packet', id, packetFile);
  assert.match(await readFile(packetFile, 'utf8'), /Imported from saved page/);
});

test('CLI text import stays backward compatible with supplied-text provenance', async t => {
  const { root, cli, catalog } = await workspace(t);
  const id = 'abcdefghijk';
  cli('add', `https://youtu.be/${id}`);
  const file = path.join(root, 't.txt');
  await writeFile(file, 'Plain pasted transcript.');
  cli('transcript', id, file);
  const video = JSON.parse(await catalog()).videos[id];
  assert.equal(video.state, 'ready');
  assert.equal(video.provenance.method, 'supplied-text');
  await writeFile(file, '');
  cli('transcript', id, file);
  const blocked = JSON.parse(await catalog()).videos[id];
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.provenance, undefined);
});

test('CLI unknown or missing args and malformed or segment-free HTML leave catalog unchanged', async t => {
  const { root, cli, catalog } = await workspace(t);
  const id = 'abcdefghijk';
  cli('add', `https://youtu.be/${id}`);
  const file = path.join(root, 'bad.txt');
  await writeFile(file, `${SEGMENT('Good.')}<transcript-segment-view-model><span role="text">truncated`);
  const before = await catalog();
  for (const args of [
    ['transcript', id],
    ['transcript', id, file, '--bogus'],
    ['transcript', id, file, '--format', 'xml'],
    ['transcript', id, file, '--format'],
    ['transcript', id, file, 'extra'],
    ['transcript', 'unknownid', file],
  ]) assert.throws(() => cli(...args));
  await writeFile(file, '<html><p>No segments</p></html>');
  cli('transcript', id, file, '--format', 'html');
  const blocked = JSON.parse(await catalog()).videos[id];
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.reason, 'No usable transcript');
  await writeFile(file, 'oops');
  const beforeMalformed = await catalog();
  await writeFile(file, `${SEGMENT('Half')} <!-- open`);
  assert.throws(() => cli('transcript', id, file, '--format', 'html'), /unterminated comment/);
  assert.equal(await catalog(), beforeMalformed);
  assert.match(JSON.parse(await catalog()).videos[id].reason, /No usable transcript/);
  await writeFile(file, 'text');
  cli('transcript', id, file);
  assert.equal(JSON.parse(await catalog()).videos[id].state, 'ready');
});
