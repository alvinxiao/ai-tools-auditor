import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';
import { withCatalog } from '../src/store.mjs';
import { FEED_LIMIT, discover, fetchChannelFeed, parseFeed } from '../src/discovery.mjs';

// Idempotent: every run operates in a disposable fresh workspace under the
// git-ignored verification/discovery directory, so repeated runs cannot see
// state from previous runs.
const base = path.resolve('verification/discovery');
await mkdir(base, { recursive: true });
const run = await mkdtemp(path.join(base, 'run-'));
const state = path.join(run, 'state');
const vault = path.join(run, 'vault');
const channel = 'UC1234567890123456789012';
const liveChannel = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const now = Date.parse('2026-11-10T00:00:00Z');
const healthy = [];
const feed = entries => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<yt:channelId>${channel}</yt:channelId>
${entries.map(([id, published]) => `<entry><yt:videoId>${id}</yt:videoId><published>${published}</published></entry>`).join('\n')}
</feed>`;
const fetchOk = body => async () => ({ ok: true, status: 200, headers: { get: () => null }, body: { getReader() { let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: new TextEncoder().encode(body) }), cancel: async () => {} }; } } });

await main(['--state', state, 'init', '--vault', vault]).catch(error => { if (!/already initialized/i.test(error.message)) throw error; });
await main(['--state', state, 'channel', 'add', `https://www.youtube.com/channel/${channel}`]);
// Fixture-driven poll with an injected fetch; no real network request occurs.
await withCatalog(state, async (catalog, save) => {
  const first = await discover(catalog, { fetch: fetchOk(feed([['abc_def-123', '2026-11-01T00:00:00+00:00']])), now });
  assert.equal(first[0].queued, 0, 'first poll baselines and queues nothing');
  // Explicit backfill after the baseline must still queue current feed IDs.
  const backfill = await discover(catalog, { fetch: fetchOk(feed([['abc_def-123', '2026-11-01T00:00:00+00:00']])), now: now + 3600_000, backfill: true });
  assert.equal(backfill[0].queued, 1, 'explicit backfill queues baseline-seen IDs absent from the catalog');
  const second = await discover(catalog, { fetch: fetchOk(feed([['abc_def-123', '2026-11-01T00:00:00+00:00'], ['newUpload01', '2026-11-09T12:00:00+00:00']])), now: now + 86_400_000 });
  assert.equal(second[0].queued, 1, 'new upload queued');
  assert.equal(catalog.videos.newUpload01.state, 'queued');
  await save(catalog);
});
await main(['--state', state, 'render']);
const dashboard = await readFile(path.join(vault, 'dashboard.md'), 'utf8');
assert.match(dashboard, /## Channels/);
assert.match(dashboard, new RegExp(channel));
await withCatalog(state, async (catalog, save) => {
  catalog.channels[channel].reason = 'Fixture failed feed stays visible.';
  catalog.channels[channel].state = 'failed';
  await save(catalog);
});
await main(['--state', state, 'render']);
const failedDashboard = await readFile(path.join(vault, 'dashboard.md'), 'utf8');
assert.match(failedDashboard, /Fixture failed feed stays visible/);
const catalog = JSON.parse(await readFile(path.join(state, 'catalog.json'), 'utf8'));
assert.equal(catalog.monitoring, false, 'monitoring must remain disabled');
healthy.push('fixture baseline, backfill, queueing, and dashboard channels verified');

// Live public YouTube feed validation (no packages). Recorded as a
// limitation when the fetch or parse is blocked.
let live;
{
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${liveChannel}`, {
      redirect: 'error', signal: controller.signal, credentials: 'omit',
    });
    try {
      if (response.status === 429 || !response.ok) {
        live = `live feed HTTP ${response.status}; parser validated against fixture only`;
      } else {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
          const read = await reader.read();
          if (read.done) break;
          size += read.value.byteLength;
          if (size > FEED_LIMIT) throw new Error('live feed exceeds 1 MiB');
          chunks.push(read.value);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = parseFeed(body, liveChannel);
        live = `live public YouTube feed parsed: ${parsed.entries.length} entries from ${liveChannel}`;
      }
    } finally {
      await response.body?.cancel?.()?.catch?.(() => {});
    }
  } catch (error) {
    live = `live feed validation unavailable (${error?.message ?? 'fetch blocked'}); parser validated against fixture only`;
  } finally {
    clearTimeout(timer);
  }
}
healthy.push(live);
await rm(run, { recursive: true, force: true });
await writeFile(path.join(base, 'VERIFY.md'), healthy.map((line, index) => `${index + 1}. ${line}`).join('\n') + '\n', 'utf8');
console.log(`PASS: ${healthy[0]}. Synthetic vault run discarded; artifacts: ${path.join(base, 'VERIFY.md')}`);
console.log(`LIVE: ${live}`);
