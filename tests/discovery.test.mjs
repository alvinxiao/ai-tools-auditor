import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { applyFeed, channelId, discover, ensureChannels, feedUrl, fetchChannelFeed, parseFeed, retryAfterFrom } from '../src/discovery.mjs';

const CHANNEL = 'UC1234567890123456789012';
const CHANNEL_B = 'UCabcdefghijklmnopqrstuv';
const PUBLISHED = '2026-11-01T00:00:00+00:00';

const feed = (ids, channel = CHANNEL) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<yt:channelId>${channel}</yt:channelId>
${ids.map(id => `<entry><yt:videoId>${id}</yt:videoId><published>${PUBLISHED}</published></entry>`).join('\n')}
</feed>`;

// Representative canonical YouTube channel feed: declared media namespace,
// xml:lang, namespace-qualified identity IDs, attribute quoting, and entity
// references in titles, links, and descriptions.
const canonicalFeed = (videoId, channel = CHANNEL) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media='http://search.yahoo.com/mrss/' xml:lang="en-US" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<yt:channelId>${channel}</yt:channelId>
<link rel="self" href="https://www.youtube.com/feeds/videos.xml?channel_id=${channel}"/>
<id>yt:channel:${channel}</id>
<title>Latest uploads &amp; uploads</title>
<updated>2026-11-09T18:21:09+00:00</updated>
<entry>
<id>yt:video:${videoId}</id>
<yt:videoId>${videoId}</yt:videoId>
<yt:channelId>${channel}</yt:channelId>
<title>Feed &quot;test&#39; title&quot; &amp; notes</title>
<link rel='alternate' href='https://www.youtube.com/watch?v=${videoId}'/>
<published>2026-11-09T15:52:48+00:00</published>
<updated>2026-11-09T15:52:48+00:00</updated>
<author><name>Test Channel</name><uri>https://www.youtube.com/channel/${channel}</uri></author>
<media:group>
<media:title>Media &quot;title&quot; &amp; notes</media:title>
<media:content url='https://www.youtube.com/v/${videoId}?version=3' type="application/x-shockwave-flash" width="640" height="390" medium="video" isDefault='true'/>
<media:thumbnail url='https://i.ytimg.com/vi/${videoId}/hqdefault.jpg' width="480" height="360"/>
<media:description>&#39;Watch now&#39; &amp; quotes &quot;stay in metadata</media:description>
<media:community>
<media:starRating count="0" average="0.00" min="0" max="5"/>
<media:statistics views="0"/>
</media:community>
</media:group>
</entry>
</feed>`;

function catalogWith(...channelIds) {
  return {
    version: 1,
    vault: 'vault',
    videos: {},
    tools: {},
    assessments: {},
    comparisons: {},
    monitoring: false,
    channels: Object.fromEntries(channelIds.map(id => [id, { id, addedAt: '2026-11-01T00:00:00Z', initialized: false, seenVideoIds: [], state: 'configured' }])),
  };
}

const now = Date.parse('2026-11-10T00:00:00Z');
const fetchOk = body => async () => ({ ok: true, status: 200, body: { getReader() { let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: new TextEncoder().encode(body) }), cancel: async () => {} }; } }, headers: { get: () => null } });

test('channel IDs are exact UC identifiers or canonical channel URLs only', async () => {
  assert.equal(channelId(CHANNEL), CHANNEL);
  assert.equal(channelId(`https://www.youtube.com/channel/${CHANNEL}`), CHANNEL);
  for (const bad of [
    'UCshort', 'handle-name', 'https://www.youtube.com/@handle',
    `https://www.youtube.com/channel/${CHANNEL}?si=x`, 'http://www.youtube.com/channel/UC1234567890123456789012',
    `https://www.youtube.com:8443/channel/${CHANNEL}`, `https://www.youtube.com:80/channel/${CHANNEL}`,
    `https://youtube.com.evil.test/channel/${CHANNEL}`, 'https://www.youtube.com/c/name', 'UC1234567890123456789012 ',
  ]) assert.throws(() => channelId(bad), /Expected a YouTube channel ID/);
  await assert.rejects(() => fetchChannelFeed('UCshort', async () => ({})), /Invalid channel ID/);
  assert.equal(feedUrl(CHANNEL), `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`);
});

test('first successful poll baselines the feed and queues nothing; explicit backfill queues it', () => {
  const catalog = catalogWith(CHANNEL);
  const [record] = Object.values(catalog.channels);
  let queued = applyFeed(catalog, record, parseFeed(feed(['abc_def-123']), CHANNEL, { now }).entries, { now });
  assert.equal(queued, 0);
  assert.equal(record.initialized, true);
  assert.deepEqual(record.seenVideoIds, ['abc_def-123']);
  assert.equal(record.state, 'ready');

  const fresh = catalogWith(CHANNEL);
  const [freshRecord] = Object.values(fresh.channels);
  queued = applyFeed(fresh, freshRecord, parseFeed(feed(['abc_def-123']), CHANNEL, { now }).entries, { backfill: true, now });
  assert.equal(queued, 1);
  assert.deepEqual(fresh.videos['abc_def-123'], {
    id: 'abc_def-123', url: 'https://www.youtube.com/watch?v=abc_def-123',
    state: 'queued', channelId: CHANNEL, discoveredAt: new Date(now).toISOString(),
  });
});

test('canonical feeds with declared media namespace and xml:lang parse; identity fields stay authoritative', () => {
  const parsed = parseFeed(canonicalFeed('fIxTuRe_001'), CHANNEL, { now });
  assert.deepEqual(parsed.entries, [{ videoId: 'fIxTuRe_001', published: '2026-11-09T15:52:48+00:00' }]);
  const catalog = catalogWith(CHANNEL);
  const record = Object.values(catalog.channels)[0];
  assert.equal(applyFeed(catalog, record, parsed.entries, { backfill: true, now: Date.parse('2026-11-09T16:00:00Z') }), 1);

  const rejected = [
    ['media namespace redeclared on an entry', canonicalFeed('fIxTuRe_001').replace('<media:group>', '<media:group xmlns:media="http://evil.test/mrss/">')],
    ['undeclared media prefix', canonicalFeed('fIxTuRe_001').replace(/ xmlns:media='http:\/\/search\.yahoo\.com\/mrss\//, '')],
    ['wrong media namespace URN', canonicalFeed('fIxTuRe_001').replace('http://search.yahoo.com/mrss/', 'http://evil.test/mrss/')],
    ['xmlns rebinding on a child element', canonicalFeed('fIxTuRe_001').replace('<entry>', '<entry xmlns:yt="http://evil.test/2015">')],
    ['undeclared prefixed attribute', canonicalFeed('fIxTuRe_001').replace('medium="video"', 'evil:medium="video"')],
    ['non-canonical xml:lang value', canonicalFeed('fIxTuRe_001').replace('en-US', 'not a langu age')],
  ];
  for (const [label, body] of rejected) {
    assert.throws(() => parseFeed(body, CHANNEL, { now }), Error, label);
  }
  // Fake yt fields in attributes are still ignored metadata; rebinding-free
  // parser never promotes something to an identity field via attribute games.
  assert.deepEqual(parseFeed(canonicalFeed('fIxTuRe_001').replace('type="application/x-shockwave-flash"', 'yt:videoId="short"'), CHANNEL, { now }).entries.map(e => e.videoId), ['fIxTuRe_001']);

  // Live canonical feeds echo the feed-root yt:channelId without the UC
  // prefix while entries keep the full UC-prefixed ID; both forms validate
  // against the one configured channel and nothing else is accepted.
  const echoFeed = canonicalFeed('fIxTuRe_002').replace(`<yt:channelId>${CHANNEL}</yt:channelId>`, '<yt:channelId>' + CHANNEL.slice(2) + '</yt:channelId>');
  assert.deepEqual(parseFeed(echoFeed, CHANNEL, { now }).entries.map(e => e.videoId), ['fIxTuRe_002']);
  assert.throws(() => parseFeed(echoFeed.replace(CHANNEL.slice(2), CHANNEL_B.slice(2)), CHANNEL, { now }), /channel ID/);
});

test('explicit backfill after a normal baseline queues existing feed videos missing from the catalog', () => {
  const catalog = catalogWith(CHANNEL);
  const record = Object.values(catalog.channels)[0];
  applyFeed(catalog, record, parseFeed(feed(['abc_def-123']), CHANNEL, { now }).entries, { now });
  assert.deepEqual(record.seenVideoIds, ['abc_def-123']);
  assert.deepEqual(catalog.videos, {});
  assert.equal(applyFeed(catalog, record, parseFeed(feed(['abc_def-123', 'newUpload01']), CHANNEL, { now: now + 1000 }).entries, { backfill: true, now: now + 1000 }), 2);
  assert.equal(catalog.videos['abc_def-123'].state, 'queued');
  assert.equal(catalog.videos.newUpload01.state, 'queued');
  assert.deepEqual(record.seenVideoIds.sort(), ['abc_def-123', 'newUpload01']);
});

test('later polls queue unseen uploads and repeats are no-ops', () => {
  const catalog = catalogWith(CHANNEL);
  const record = Object.values(catalog.channels)[0];
  const first = parseFeed(feed(['abc_def-123']), CHANNEL, { now }).entries;
  applyFeed(catalog, record, first, { backfill: true, now });
  assert.equal(applyFeed(catalog, record, first, { now: now + 1000 }), 0);
  const second = parseFeed(feed(['abc_def-123', 'newUpload01']), CHANNEL, { now }).entries;
  assert.equal(applyFeed(catalog, record, second, { now: now + 2000 }), 1);
  assert.equal(catalog.videos.newUpload01.state, 'queued');
  assert.deepEqual(record.seenVideoIds.sort(), ['abc_def-123', 'newUpload01']);
});

test('entries falling out of the finite feed stay seen and never re-queue', () => {
  const catalog = catalogWith(CHANNEL);
  const record = Object.values(catalog.channels)[0];
  applyFeed(catalog, record, parseFeed(feed(['abc_def-123', 'oldVideo000']), CHANNEL, { now }).entries, { backfill: true, now });
  assert.equal(applyFeed(catalog, record, parseFeed(feed(['abc_def-123']), CHANNEL, { now }).entries, { now }), 0);
  assert.equal(applyFeed(catalog, record, parseFeed(feed(['oldVideo000', 'abc_def-123']), CHANNEL, { now }).entries, { now }), 0);
});

test('an existing video keeps its state and transcript when discovery sees it', () => {
  const catalog = catalogWith(CHANNEL, CHANNEL_B);
  catalog.videos['abc_def-123'] = { id: 'abc_def-123', url: 'https://www.youtube.com/watch?v=abc_def-123', state: 'ready', transcript: 'Keep me' };
  const [a, b] = Object.values(catalog.channels);
  applyFeed(catalog, a, parseFeed(feed(['abc_def-123']), CHANNEL, { now }).entries, { backfill: true, now });
  applyFeed(catalog, b, parseFeed(feed(['abc_def-123'], CHANNEL_B), CHANNEL_B, { now }).entries, { backfill: true, now });
  assert.equal(catalog.videos['abc_def-123'].state, 'ready');
  assert.equal(catalog.videos['abc_def-123'].transcript, 'Keep me');
  assert.equal(catalog.videos['abc_def-123'].channelId, undefined);
});

test('malformed feeds, entity injections, and channel mismatches reject without advancing state', async () => {
  const bad = [
    feed(['abc_def-123']).replace('<feed ', '<!DOCTYPE feed [<!ENTITY x "y">]><feed '),
    feed(['abc_def-123']).replace(CHANNEL, CHANNEL_B),
    feed(['abc_def-123']).replace(/<\/feed>/, ''),
    feed(['abc_def-123']).replace('<yt:videoId>abc_def-123</yt:videoId>', '<yt:videoId>abc_def-123<yt:videoId>x</yt:videoId>'),
    feed(['abc_def-123']).replace(PUBLISHED, '2027-01-01T00:00:00+00:00'),
    feed(['abc_def-123']).replace('xmlns:yt="http://www.youtube.com/xml/schemas/2015"', 'xmlns:yt="http://evil.test/2015"'),
    feed(['abc_def-123']).replace('<yt:channelId>', '<yt:channelId>&#0;'),
    feed(['abc_def-123']).replace('<feed xmlns="http://www.w3.org/2005/Atom"', '<feed xmlns="http://evil.test/Atom"'),
    feed(['shortid']),
    '',
    feed(['abc_def-123']).slice(0, 120),
  ];
  for (const [index, body] of bad.entries()) {
    const catalog = catalogWith(CHANNEL);
    const record = Object.values(catalog.channels)[0];
    assert.throws(() => parseFeed(body, CHANNEL, { now }), Error, `fixture ${index} should reject`);
    const [result] = await discover(catalog, { fetch: fetchOk(body), now });
    assert.equal(result.state, 'failed', `fixture ${index} should fail discovery`);
    assert.equal(result.reason, record.reason);
    assert.equal(record.state, 'failed');
    assert.equal(record.initialized, false, `fixture ${index} must not advance the baseline`);
    assert.deepEqual(record.seenVideoIds, [], `fixture ${index} must not advance the seen set`);
    assert.equal('lastCheckedAt' in record, false, `fixture ${index} must not record a successful check`);
    assert.match(record.reason ?? '', /Feed rejected|request failed/);
  }
});

test('mixed success and failure persists per channel', async () => {
  const catalog = catalogWith(CHANNEL, CHANNEL_B);
  const bodies = { [CHANNEL]: feed(['abc_def-123']) };
  const results = await discover(catalog, { fetch: async url => {
    if (url.endsWith(`channel_id=${CHANNEL}`)) return (await fetchOk(bodies[CHANNEL]))();
    return { ok: false, status: 503, headers: { get: () => null } };
  }, now, backfill: true });
  assert.deepEqual(results.map(r => r.state), ['ready', 'failed']);
  assert.match(results[1].reason, /HTTP 503/);
  assert.equal(catalog.channels[CHANNEL].state, 'ready');
  assert.equal(catalog.videos['abc_def-123'].state, 'queued');
  assert.equal(catalog.channels[CHANNEL_B].state, 'failed');
  assert.equal(catalog.channels[CHANNEL_B].initialized, false);
  assert.deepEqual(catalog.channels[CHANNEL_B].seenVideoIds, []);
});

test('HTTP 429 starts a capped cooldown and skips polls until it expires', async () => {
  const catalog = catalogWith(CHANNEL);
  let calls = 0;
  const rateLimited = async () => { calls++; return { ok: false, status: 429, headers: { get: name => name === 'retry-after' ? '30' : null } }; };
  let results = await discover(catalog, { fetch: rateLimited, now });
  assert.equal(results[0].state, 'failed');
  assert.match(results[0].reason, /429/);
  const retryAfter = catalog.channels[CHANNEL].retryAfter;
  assert.equal(Date.parse(retryAfter) - now, 30_000);
  results = await discover(catalog, { fetch: rateLimited, now: now + 1000 });
  assert.equal(calls, 1);
  assert.equal(results[0].skipped, true);
  results = await discover(catalog, { fetch: rateLimited, now: now + 31_000 });
  assert.equal(calls, 2);
  assert.equal(results[0].skipped, undefined);
  assert.equal(Date.parse(retryAfterFrom('999999', now)) - now, 3_600_000);
  assert.equal(Date.parse(retryAfterFrom('Mon, 10 Nov 2026 01:00:00 GMT', now)) - now, 3_600_000);
  assert.equal(Date.parse(retryAfterFrom('garbage', now)) - now, 900_000);
  assert.equal(catalog.channels[CHANNEL].initialized, false);
});

test('fetch failures keep state failed; timeout and size bounds return failures', async () => {
  const catalog = catalogWith(CHANNEL);
  const results = await discover(catalog, { fetch: async () => { const error = new Error('socket hung up'); throw error; }, now });
  assert.equal(results[0].state, 'failed');
  assert.match(results[0].reason, /socket hung up/);
  assert.equal(catalog.channels[CHANNEL].state, 'failed');
  const timeout = await fetchChannelFeed(CHANNEL, async (url, init) => {
    assert.equal(url, feedUrl(CHANNEL));
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.ok(init.signal);
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  });
  assert.equal(timeout.state, 'failed');
  assert.match(timeout.reason, /timed out/);
  const oversized = await fetchChannelFeed(CHANNEL, fetchOk('x'.repeat(1_100_000)));
  assert.equal(oversized.state, 'failed');
  assert.match(oversized.reason, /1 MiB/);
});

test('unused error and rate-limit response bodies are canceled to release connections', async () => {
  const responses = [];
  const makeResponse = status => {
    const record = { status, cancels: 0, response: { ok: status === 200, status, headers: { get: () => null }, body: { cancel: async () => { record.cancels++; } } } };
    return record;
  };
  const limited = makeResponse(429);
  const limitResult = await fetchChannelFeed(CHANNEL, async () => limited.response);
  assert.equal(limitResult.state, 'rate_limited');
  assert.equal(limited.cancels, 1);
  const rejected = makeResponse(503);
  const failedResult = await fetchChannelFeed(CHANNEL, async () => rejected.response);
  assert.equal(failedResult.state, 'failed');
  assert.equal(rejected.cancels, 1);
  const noBody = await fetchChannelFeed(CHANNEL, async (url, init) => {
    assert.equal(init.credentials, 'omit');
    return { ok: true, status: 200, headers: { get: () => null }, body: null };
  });
  assert.equal(noBody.state, 'failed');
  assert.match(noBody.reason, /no readable body/);
});

test('discovery handles old v1 catalogs without a channels map and empty channel lists', async () => {
  const catalog = { version: 1, vault: 'vault', videos: {}, tools: {}, assessments: {}, comparisons: {}, monitoring: false };
  const results = await discover(catalog, { fetch: async () => { throw new Error('must not fetch'); }, now });
  assert.deepEqual(results, []);
  assert.deepEqual(catalog.channels, {});
});

test('CLI channel commands, status, and dashboard reflect discovery state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'auditor-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  const cli = (...args) => execFileSync(process.execPath, ['src/cli.mjs', '--state', state, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  cli('init', '--vault', path.join(root, 'vault'));
  assert.throws(() => cli('channel', 'add', 'https://www.youtube.com/@handle'));
  cli('channel', 'add', `https://www.youtube.com/channel/${CHANNEL}`);
  assert.match(cli('channel', 'add', CHANNEL), /already configured/);
  assert.throws(() => cli('channel', 'remove', CHANNEL_B));
  assert.match(cli('status'), new RegExp(CHANNEL));
  assert.throws(() => cli('discover', '--wat'));
  cli('channel', 'remove', CHANNEL);
  const discovered = JSON.parse(cli('discover'));
  assert.deepEqual(discovered.results, []);
  assert.deepEqual(JSON.parse(cli('channel', 'list')), {});
  const catalog = JSON.parse(await readFile(path.join(state, 'catalog.json')));
  assert.equal(catalog.monitoring, false);
  assert.deepEqual(catalog.channels, {});
});
