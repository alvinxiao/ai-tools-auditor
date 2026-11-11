import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { atomicWrite, readJson, withCatalog } from './store.mjs';
import { applyImport, exampleAssessment, hash, packet, planSourceNotes, render, text, validateImport, videoId } from './auditor.mjs';
import { retrieveTranscript, YT_DLP_VERSION } from './retrieval.mjs';
import { parseHtmlTranscript } from './transcripts.mjs';
import { channelId as parseChannelId, discover, ensureChannels } from './discovery.mjs';
import { fetchVideoTitle } from './metadata.mjs';
import { validateTitle } from './titles.mjs';

export async function main(args = process.argv.slice(2)) {
  let state = path.resolve('.auditor');
  const stateIndex = args.indexOf('--state');
  if (stateIndex !== -1) {
    if (!args[stateIndex + 1]) throw new Error('--state requires a directory');
    state = path.resolve(args[stateIndex + 1]); args.splice(stateIndex, 2);
  }
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') return 'Usage: node src/cli.mjs [--state DIR] init [--vault DIR] | profile FILE | add URL [--title TITLE] | title ID TITLE | metadata ID | channel add ID | channel list | channel remove ID | discover [--backfill] | retrieve ID | transcript ID FILE [--format text|html] | block ID REASON | fail ID REASON | retry ID | packet ID [FILE] | import FILE | status | render | example [ID]';
  if (command === 'example') return JSON.stringify(exampleAssessment(rest[0]), null, 2);
  return withCatalog(state, async (catalog, save) => {
    let discoveryResults;
    if (command === 'init') {
      if (catalog) throw new Error('Catalog already initialized');
      if (rest.length && (rest.length !== 2 || rest[0] !== '--vault')) throw new Error('init accepts --vault DIR');
      catalog = { version: 1, vault: path.resolve(rest[1] ?? 'output/vault'), profile: 'Personal software and automation. Prefer local-data tools when similarly capable. Budget and hardware constraints unspecified. Compare practical small builds against buying, adapting, existing tools and skipping. Do not assume paid API access.', videos: {}, tools: {}, assessments: {}, comparisons: {}, monitoring: false };
      await save(catalog); await render(catalog); return `Initialized. Vault: ${catalog.vault}`;
    }
    if (!catalog || catalog.version !== 1) throw new Error('Run init first; expected catalog version 1');
    if (command === 'status') return JSON.stringify({ vault: catalog.vault, monitoring: false, channels: catalog.channels ?? {}, videos: catalog.videos, toolCount: Object.keys(catalog.tools).length }, null, 2);
    if (command === 'channel') {
      const [action, value] = rest;
      if (action === 'list') return JSON.stringify(catalog.channels ?? {}, null, 2);
      if (!action || !['add', 'remove'].includes(action)) throw new Error('channel accepts add | list | remove');
      const id = parseChannelId(value);
      ensureChannels(catalog);
      if (action === 'add') {
        if (Object.hasOwn(catalog.channels, id)) return `Channel already configured: ${id}`;
        catalog.channels[id] = { id, addedAt: new Date().toISOString(), initialized: false, seenVideoIds: [], state: 'configured' };
      } else {
        if (!Object.hasOwn(catalog.channels, id)) throw new Error(`Channel not configured: ${id}`);
        delete catalog.channels[id];
      }
    } else if (command === 'discover') {
      const backfill = rest.includes('--backfill');
      if (rest.some(value => value !== '--backfill')) throw new Error('discover accepts --backfill');
      ensureChannels(catalog);
      discoveryResults = await discover(catalog, { backfill });
    }
    if (command === 'render') { await planSourceNotes(catalog); await save(catalog); await render(catalog); return 'Rendered committed catalog.'; }
    if (command === 'packet') {
      const content = JSON.stringify(await packet(catalog, rest[0]), null, 2);
      if (rest[1]) { await atomicWrite(path.resolve(rest[1]), content + '\n'); return `Research packet: ${path.resolve(rest[1])}`; }
      return content;
    }
    if (command === 'profile') {
      catalog.profile = text(await readFile(rest[0], 'utf8'), 'profile');
    } else if (command === 'channel' || command === 'discover') {
    } else if (command === 'add') {
      if (rest.length > 3 || (rest.length > 1 && (rest[1] !== '--title' || rest.length !== 3))) throw new Error('add accepts URL [--title TITLE]');
      const id = videoId(rest[0]);
      if (Object.hasOwn(catalog.videos, id)) return `Already queued: ${id}`;
      const video = { id, url: `https://www.youtube.com/watch?v=${id}`, state: 'queued' };
      if (rest.length === 3) video.title = validateTitle(rest[2], '--title');
      catalog.videos[id] = video;
    } else if (command === 'title') {
      if (rest.length !== 2) throw new Error('title accepts ID TITLE');
      const video = Object.hasOwn(catalog.videos, rest[0]) ? catalog.videos[rest[0]] : undefined;
      if (!video) throw new Error('Unknown video');
      video.title = validateTitle(rest[1], 'title');
    } else if (command === 'metadata') {
      if (rest.length !== 1) throw new Error('metadata accepts ID');
      const video = Object.hasOwn(catalog.videos, rest[0]) ? catalog.videos[rest[0]] : undefined;
      if (!video) throw new Error('Unknown video');
      video.title = (await fetchVideoTitle(rest[0])).title;
    } else if (command === 'import') {
      const assessment = validateImport(await readJson(rest[0]), catalog);
      if (!applyImport(catalog, assessment)) { await planSourceNotes(catalog); await save(catalog); await render(catalog); return 'Already imported; rendered catalog.'; }
      await atomicWrite(path.join(state, 'assessments', `${hash(assessment)}.json`), JSON.stringify(assessment, null, 2) + '\n');
    } else if (['retrieve', 'transcript', 'block', 'fail', 'retry'].includes(command)) {
      const video = Object.hasOwn(catalog.videos, rest[0]) ? catalog.videos[rest[0]] : undefined;
      if (!video) throw new Error('Unknown video');
      if (command === 'retrieve') {
        if (video.retrieval?.retryAfter && Date.parse(video.retrieval.retryAfter) > Date.now()) return `Rate limited. Retry after ${video.retrieval.retryAfter}`;
        const result = await retrieveTranscript(video.id, { artifact: path.join(state, 'runtime', 'yt-dlp') })
          .catch(error => ({ state: 'failed', reason: error.message.replace(/<!--/g, '').slice(0, 4000) }));
        delete video.transcript;
        delete video.reason;
        video.state = result.state;
        if (result.transcript) video.transcript = result.transcript;
        if (result.reason) video.reason = result.reason;
        video.retrieval = { tool: 'yt-dlp', version: YT_DLP_VERSION, attemptedAt: new Date().toISOString(), ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}), ...(result.warning ? { warning: result.warning } : {}) };
      } else if (command === 'transcript') {
        if (rest.length < 2 || rest.length > 4 || (rest.length > 2 && (rest[2] !== '--format' || !['text', 'html'].includes(rest[3])))) {
          throw new Error('transcript accepts ID FILE [--format text|html]');
        }
        const format = rest[2] === '--format' ? rest[3] : 'text';
        const raw = await readFile(rest[1], 'utf8');
        const transcript = format === 'html' ? parseHtmlTranscript(raw) : raw;
        if (format === 'text' && Buffer.byteLength(transcript) > 2_000_000) throw new Error('Transcript exceeds 2 MB');
        if (!transcript.trim()) { delete video.transcript; delete video.provenance; video.state = 'blocked'; video.reason = 'No usable transcript'; }
        else {
          video.transcript = transcript; video.state = 'ready'; delete video.reason;
          video.provenance = { method: format === 'html' ? 'supplied-html' : 'supplied-text', importedAt: new Date().toISOString() };
          if (video.retrieval) { delete video.retrieval.retryAfter; delete video.retrieval.warning; }
        }
      } else if (command === 'retry') { video.state = video.transcript ? 'ready' : 'queued'; delete video.reason; }
      else { video.state = command === 'block' ? 'blocked' : 'failed'; video.reason = text(rest.slice(1).join(' '), 'reason'); }
    } else throw new Error(`Unknown command: ${command}`);
    await planSourceNotes(catalog);
    await save(catalog);
    try { await render(catalog); }
    catch (error) { throw new Error(`Catalog saved, vault render incomplete. Fix note conflict and run render. ${error.message}`); }
    if (discoveryResults) return JSON.stringify({ channels: catalog.channels, results: discoveryResults }, null, 2);
    return 'Saved and rendered.';
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(result)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
