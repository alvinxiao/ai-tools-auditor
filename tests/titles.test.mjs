import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exampleAssessment, planSourceNotes, sourceId, sourceLabel } from '../src/auditor.mjs';
import { applyFeed, parseFeed } from '../src/discovery.mjs';
import { oembedUrl, fetchVideoTitle, storeTitle } from '../src/metadata.mjs';
import { titleBase, validateTitle } from '../src/titles.mjs';

const CHANNEL = 'UC1234567890123456789012';
const PUBLISHED = '2026-11-01T00:00:00+00:00';
const now = Date.parse('2026-11-10T00:00:00Z');

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auditor-titles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const vault = path.join(root, 'vault');
  const cli = (...args) => execFileSync(process.execPath, ['src/cli.mjs', '--state', state, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  cli('init', '--vault', vault);
  return { root, state, vault, cli };
}

const bodyResponse = text => ({ ok: true, status: 200, headers: { get: () => null },
  body: { getReader() { let sent = false; return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: new TextEncoder().encode(text) }), cancel: async () => {} }; } } });

test('titles validate at the boundary: single line, size, control chars, markers', () => {
  assert.equal(validateTitle('  A fine title  '), 'A fine title');
  for (const value of ['', '   ', '\n', undefined, 42, null]) {
    assert.throws(() => validateTitle(value), /Invalid title/, String(value));
  }
  assert.throws(() => validateTitle('x'.repeat(501)), /500 characters/);
  for (const value of ['two\nlines', 'back\r\nreturn', 'ctrl\u0007', 'nul\u0000', 'bell\u0008', 'esc\u001b']) {
    assert.throws(() => validateTitle(value), /single line without control/);
  }
  assert.throws(() => validateTitle('<!-- auditor:generated:start -->'), /marker/);
  assert.throws(() => validateTitle('peek <!-- auditor:generated:whatever'), /marker/);
  assert.equal(validateTitle('Bad <script> but allowed'), 'Bad <script> but allowed');
});

test('title slugs are ASCII, size-capped, and Windows reserved names are prefixed', () => {
  assert.equal(titleBase('Hello, World! Élan'), 'hello-world-lan');
  assert.equal(titleBase('The    Best -- Tool (2026)'), 'the-best-tool-2026');
  assert.equal(titleBase('CON'), 'video-con');
  assert.equal(titleBase('lpt1'), 'video-lpt1');
  assert.equal(titleBase('日本語だけ'), null);
  assert.equal(titleBase(undefined), null);
  assert.equal(titleBase('x'.repeat(300)), 'x'.repeat(80));
  assert.equal(sourceLabel({ title: 'Named' }), 'Named');
  assert.equal(sourceLabel({}), 'Title unavailable');
  assert.equal(sourceLabel(undefined), 'Title unavailable');
});

test('metadata uses the fixed official oEmbed URL and validates only the payload title', async () => {
  assert.equal(oembedUrl('Abc_def-123'),
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=Abc_def-123')}`);
  assert.throws(() => oembedUrl('short'), /Invalid video ID/);
  assert.throws(() => oembedUrl(undefined), /Invalid video ID/);
  assert.equal(storeTitle({ id: 'Abc_def-123', title: ' Real Title ' }).title, 'Real Title');
  assert.throws(() => storeTitle({ title: '' }), /nonempty/);
  assert.throws(() => storeTitle({ title: 'a\nb' }), /single line/);
  assert.throws(() => storeTitle({}), /expected a string/);
  assert.throws(() => storeTitle(null), /not an object/);
  assert.throws(() => storeTitle([1]), /not an object/);

  let captured;
  const fetchOk = async (url, init) => {
    captured = { url, init };
    return bodyResponse('{"title":"Broken, but \\"fine\\" & caps"}');
  };
  assert.equal((await fetchVideoTitle('Abc_def-123', fetchOk)).title, 'Broken, but "fine" & caps');
  assert.equal(captured.url, oembedUrl('Abc_def-123'));
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.credentials, 'omit');
  assert.ok(captured.init.signal instanceof AbortSignal);

  await assert.rejects(fetchVideoTitle('Abc_def-123', async () => {
    const error = new Error('aborted'); error.name = 'AbortError'; throw error;
  }), /timed out after 10 seconds/);
  await assert.rejects(fetchVideoTitle('Abc_def-123', async () => ({ ok: false, status: 503, headers: { get: () => null }, body: { cancel: async () => {} } })), /HTTP 503/);
  await assert.rejects(fetchVideoTitle('Abc_def-123', async () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader() { let count = 0; return { read: async () => count++ < 2 ? { done: false, value: new Uint8Array(600_000).fill(120) } : { done: true }, cancel: async () => {} }; } },
  })), /1 MiB/);
  await assert.rejects(fetchVideoTitle('Abc_def-123', async () => bodyResponse('not json at all')), /not valid JSON/);
  await assert.rejects(fetchVideoTitle('Abc_def-123', async () => bodyResponse('{"url":"no title here"}')), /expected a string/);
  await assert.rejects(fetchVideoTitle('Abc_def-123', async () => bodyResponse('{"title":"x<!-- auditor:generated:start -->y"}')), /marker/);
  await assert.rejects(fetchVideoTitle('Abc_def-123', async () => bodyResponse('{"title":"a\\nb"}')), /single line/);
  await assert.rejects(fetchVideoTitle('Abc_def-123', null), /No fetch implementation/);
});

test('a failed metadata fetch leaves the catalog unchanged', async t => {
  const { state, cli } = await workspace(t);
  cli('add', 'https://youtu.be/abcdefghijk');
  const before = await readFile(path.join(state, 'catalog.json'), 'utf8');
  assert.throws(() => cli('metadata', 'abcdefghijk'));
  assert.equal(await readFile(path.join(state, 'catalog.json'), 'utf8'), before);
  assert.throws(() => cli('metadata', 'zzzzzzzzzzz'), /Unknown video/);
  assert.throws(() => cli('metadata'), /metadata accepts/);
});

test('discovery parses and stores validated entry titles; missing titles stay backward compatible', () => {
  const titled = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<yt:channelId>${CHANNEL}</yt:channelId>
<title>Channel title stays ignored</title>
<entry><yt:videoId>abc_def-123</yt:videoId><title>Agent launchers &amp; local data &#8212; honest review</title><published>${PUBLISHED}</published></entry>
<entry><yt:videoId>videoNoTitl</yt:videoId><published>${PUBLISHED}</published></entry>
</feed>`;
  const parsed = parseFeed(titled, CHANNEL, { now });
  assert.deepEqual(parsed.entries, [
    { videoId: 'abc_def-123', published: PUBLISHED, title: 'Agent launchers & local data — honest review' },
    { videoId: 'videoNoTitl', published: PUBLISHED },
  ]);
  const catalog = { version: 1, vault: 'vault', videos: {}, tools: {}, assessments: {}, comparisons: {}, monitoring: false,
    channels: { [CHANNEL]: { id: CHANNEL, addedAt: 'x', initialized: false, seenVideoIds: [], state: 'configured' } } };
  const record = catalog.channels[CHANNEL];
  assert.equal(applyFeed(catalog, record, parsed.entries, { backfill: true, now }), 2);
  assert.equal(catalog.videos['abc_def-123'].title, 'Agent launchers & local data — honest review');
  assert.equal(catalog.videos.videoNoTitl.title, undefined);

  // An existing video keeps its state and title on feed replays.
  catalog.videos['abc_def-123'] = { id: 'abc_def-123', url: 'x', state: 'ready', transcript: 'keep' };
  assert.equal(applyFeed(catalog, record, parsed.entries, { backfill: true, now }), 0);
  assert.equal(catalog.videos['abc_def-123'].title, undefined);

  for (const [broken, expected] of [
    ['<title></title>', /invalid title|must be nonempty/],
    ['<title>a\nb</title>', /invalid title|single line/],
    [`<title>${'x'.repeat(501)}</title>`, /invalid title|500/],
    ['<title><!-- auditor:generated:start --></title>', /comment|declaration|invalid title|marker/],
    ['<title>\u0007</title>', /invalid title|single line/],
    ['<title>two</title <b>x</b></title>', /./],
  ]) {
    const body = titled.replace('<title>Agent launchers &amp; local data &#8212; honest review</title>', broken);
    assert.throws(() => parseFeed(body, CHANNEL, { now }), expected, broken.slice(0, 40));
  }

  const plain = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<yt:channelId>${CHANNEL}</yt:channelId>
<entry><yt:videoId>abc_def-123</yt:videoId><published>${PUBLISHED}</published></entry>
</feed>`;
  assert.deepEqual(parseFeed(plain, CHANNEL, { now }).entries, [{ videoId: 'abc_def-123', published: PUBLISHED }]);
});

test('planSourceNotes numbers duplicate titles and falls back when no safe slug can form', async t => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'auditor-plan-'));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const catalog = { version: 1, vault, videos: {
    aaa: { id: 'aaa', url: 'u', state: 'queued' },
    bbb: { id: 'bbb', url: 'u', state: 'queued', title: 'Same Name!!' },
    ccc: { id: 'ccc', url: 'u', state: 'queued', title: 'Same Name!!' },
    ddd: { id: 'ddd', url: 'u', state: 'queued', title: '日本語だけ' },
    eee: { id: 'eee', url: 'u', state: 'queued', title: 'CON' },
  }, tools: {}, assessments: {}, comparisons: {} };
  await planSourceNotes(catalog);
  assert.equal(catalog.videos.aaa.sourceSlug, 'untitled-video');
  assert.equal(catalog.videos.bbb.sourceSlug, 'same-name');
  assert.equal(catalog.videos.ccc.sourceSlug, 'same-name-2');
  assert.equal(catalog.videos.ddd.sourceSlug, 'untitled-video-2');
  assert.equal(catalog.videos.eee.sourceSlug, 'video-con');

  // Assigned slugs survive replans unchanged and never collide with the
  // legacy hex filename that an older catalog may still use on disk.
  delete catalog.videos.bbb.title;
  const once = JSON.parse(JSON.stringify(catalog.videos));
  await planSourceNotes(catalog);
  for (const [id, video] of Object.entries(catalog.videos)) {
    assert.equal(video.sourceSlug, once[id].sourceSlug, id);
    assert.notEqual(video.sourceSlug, sourceId('ddd'));
  }
});

// Simulates a pre-upgrade catalog: the video record carries no sourceSlug
// and its note lives under the legacy hex-encoded filename.
async function legacyFixture(t) {
  const { root, state, vault, cli } = await workspace(t);
  const id = 'abcdefghijk';
  cli('add', `https://youtu.be/${id}`);
  const legacy = path.join(vault, 'Sources', `${sourceId(id)}.md`);
  await rename(path.join(vault, 'Sources', 'untitled-video.md'), legacy);
  await writeFile(legacy, (await readFile(legacy, 'utf8')) + '\nMy personal source annotation.\n');
  const catalogFile = path.join(state, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  delete catalog.videos[id].sourceSlug;
  await writeFile(catalogFile, JSON.stringify(catalog, null, 2) + '\n');
  return { state, vault, cli, id, legacy };
}

test('migration renames the legacy hex source note and preserves personal annotations', async t => {
  const { state, vault, cli, id, legacy } = await legacyFixture(t);
  const annotated = await readFile(legacy, 'utf8');
  assert.match(annotated, /My personal source annotation\./);
  assert.match(annotated, /Title unavailable/);

  cli('title', id, 'A Great Deep Dive');
  const migrated = await readFile(path.join(vault, 'Sources', 'a-great-deep-dive.md'), 'utf8');
  assert.match(migrated, /My personal source annotation\./);
  assert.match(migrated, /# A Great Deep Dive/);
  assert.match(migrated, /Video ID: abcdefghijk/);
  assert.match(migrated, /https:\/\/www\.youtube\.com\/watch\?v=/);
  assert.ok(!(await readdir(path.join(vault, 'Sources'))).includes(`${sourceId(id)}.md`), 'legacy file moved');
  const catalog = JSON.parse(await readFile(path.join(state, 'catalog.json'), 'utf8'));
  assert.equal(catalog.videos[id].sourceSlug, 'a-great-deep-dive');
  assert.equal(catalog.videos[id].title, 'A Great Deep Dive');
  assert.deepEqual(await readdir(path.join(vault, 'Sources')), ['a-great-deep-dive.md']);
  assert.match(await readFile(path.join(vault, 'dashboard.md'), 'utf8'), /A Great Deep Dive/);
});

test('add --title names records at queue time and replay keeps the video unchanged', async t => {
  const { state, vault, cli } = await workspace(t);
  cli('add', 'https://youtu.be/abcdefghijk', '--title', 'Queued With Title');
  let catalog = JSON.parse(await readFile(path.join(state, 'catalog.json'), 'utf8'));
  assert.equal(catalog.videos['abcdefghijk'].title, 'Queued With Title');
  assert.equal(catalog.videos['abcdefghijk'].sourceSlug, 'queued-with-title');
  assert.match(await readFile(path.join(vault, 'dashboard.md'), 'utf8'), /\[Queued With Title\]/);
  const before = await readFile(path.join(state, 'catalog.json'), 'utf8');
  cli('add', 'https://www.youtube.com/watch?v=abcdefghijk');
  catalog = JSON.parse(await readFile(path.join(state, 'catalog.json'), 'utf8'));
  assert.equal(catalog.videos['abcdefghijk'].sourceSlug, 'queued-with-title');
  assert.equal(catalog.videos['abcdefghijk'].title, 'Queued With Title');
  assert.equal(await readFile(path.join(state, 'catalog.json'), 'utf8'), before);
  assert.throws(() => cli('add', 'https://youtu.be/zyxwvutsrqp', '--title'), /add accepts/);
  assert.throws(() => cli('add', 'https://youtu.be/zyxwvutsrqp', '--oops', 'x'), /add accepts/);
  assert.throws(() => cli('add', 'https://youtu.be/zyxwvutsrqp', '--title', 'a', 'b'), /add accepts/);
  assert.throws(() => cli('title', 'missing000000', 'Okay'), /Unknown video/);
  assert.throws(() => cli('title', 'abcdefghijk', 'Okay', 'extra'), /title accepts/);
  assert.throws(() => cli('title', 'abcdefghijk'), /title accepts/);
});

test('duplicate titles produce distinct source notes; superseded fallback notes migrate', async t => {
  const { vault, state, cli } = await workspace(t);
  const a = 'abcdefghijk';
  const b = 'zyxwvutsrqp';
  cli('add', `https://youtu.be/${a}`);
  cli('add', `https://youtu.be/${b}`);
  let catalog = JSON.parse(await readFile(path.join(state, 'catalog.json'), 'utf8'));
  assert.equal(catalog.videos[a].sourceSlug, 'untitled-video');
  assert.equal(catalog.videos[b].sourceSlug, 'untitled-video-2');
  const second = path.join(vault, 'Sources', 'untitled-video-2.md');
  await writeFile(second, (await readFile(second, 'utf8')) + '\nKeep second annotation.\n');

  cli('title', a, 'Two Videos, One Name');
  cli('title', b, 'Two Videos, One Name');
  catalog = JSON.parse(await readFile(path.join(state, 'catalog.json'), 'utf8'));
  assert.equal(catalog.videos[a].sourceSlug, 'two-videos-one-name');
  assert.equal(catalog.videos[b].sourceSlug, 'two-videos-one-name-2');
  const kept = await readFile(path.join(vault, 'Sources', 'two-videos-one-name-2.md'), 'utf8');
  assert.match(kept, /Keep second annotation\./);
  assert.match(kept, /Video ID: zyxwvutsrqp/);
  const other = await readFile(path.join(vault, 'Sources', 'two-videos-one-name.md'), 'utf8');
  assert.match(other, /Video ID: abcdefghijk/);
  assert.deepEqual((await readdir(path.join(vault, 'Sources'))).sort(),
    ['two-videos-one-name-2.md', 'two-videos-one-name.md']);
});

test('imported reports link title slugs in current and history notes; title refreshes duplicate nothing', async t => {
  const { root, state, vault, cli } = await workspace(t);
  const id = 'abcdefghijk';
  cli('add', `https://youtu.be/${id}`, '--title', 'First Video Title');
  const transcript = path.join(root, 'text');
  await writeFile(transcript, 'Fixture transcript');
  cli('transcript', id, transcript);
  const input = path.join(root, 'audit.json');
  await writeFile(input, JSON.stringify(exampleAssessment(id)));
  cli('import', input);

  const researchPacket = JSON.parse(cli('packet', id));
  assert.equal(researchPacket.video.title, 'First Video Title');
  assert.equal(researchPacket.video.url, `https://www.youtube.com/watch?v=${id}`);
  const toolNote = await readFile(path.join(vault, 'Tools', 'synthetic-tool.md'), 'utf8');
  assert.match(toolNote, /\[First Video Title\]\(\.\.\/Sources\/first-video-title\.md\)/);
  assert.doesNotMatch(toolNote, /video-[0-9a-f]/);
  const historyFiles = await readdir(path.join(vault, 'History'));
  assert.equal(historyFiles.length, 1);
  const historyNote = await readFile(path.join(vault, 'History', historyFiles[0]), 'utf8');
  assert.match(historyNote, /\[First Video Title\]\(\.\.\/Sources\/first-video-title\.md\)/);

  const sourceFile = path.join(vault, 'Sources', 'first-video-title.md');
  await writeFile(sourceFile, (await readFile(sourceFile, 'utf8')) + '\nPersonal provenance note.\n');
  cli('title', id, 'Renamed Source Title');
  const source = await readFile(sourceFile, 'utf8');
  assert.match(source, /# Renamed Source Title/);
  assert.match(source, /Personal provenance note\./);
  assert.deepEqual(await readdir(path.join(vault, 'Sources')), ['first-video-title.md']);
  assert.equal((await readdir(path.join(vault, 'Tools'))).length, 1);
  assert.deepEqual(await readdir(path.join(vault, 'History')), historyFiles);
  assert.match(await readFile(path.join(vault, 'Tools', 'synthetic-tool.md'), 'utf8'), /Renamed Source Title/);
  const catalog = JSON.parse(await readFile(path.join(state, 'catalog.json'), 'utf8'));
  assert.equal(catalog.videos[id].sourceSlug, 'first-video-title');
  assert.equal(catalog.videos[id].title, 'Renamed Source Title');
});

test('malformed titles cannot mutate the catalog; unmanaged target files fail safely', async t => {
  const { root, state, vault, cli } = await workspace(t);
  const id = 'abcdefghijk';
  cli('add', `https://youtu.be/${id}`);
  const before = await readFile(path.join(state, 'catalog.json'), 'utf8');
  for (const bad of ['a\nb', 'x'.repeat(501), '<!-- auditor:generated:end -->', '  ', 'ctl\u0007']) {
    assert.throws(() => cli('title', id, bad), /Invalid title/);
    assert.equal(await readFile(path.join(state, 'catalog.json'), 'utf8'), before);
  }
  await writeFile(path.join(vault, 'Sources', 'brand-new-name.md'), 'Human-authored note.\n');
  assert.throws(() => cli('title', id, 'Brand New Name'), /Refusing to overwrite/);
  assert.equal(await readFile(path.join(state, 'catalog.json'), 'utf8'), before);
  assert.equal(await readFile(path.join(vault, 'Sources', 'brand-new-name.md'), 'utf8'), 'Human-authored note.\n');
  assert.ok((await readdir(path.join(vault, 'Sources'))).includes('untitled-video.md'));
});
