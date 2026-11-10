// Explicit manual channel discovery over YouTube's public Atom feeds.
// This is preparatory discovery only: catalog.monitoring stays false and no
// scheduler runs. Feeds are fetched from one fixed URL per validated channel
// ID; nothing from feed content is ever used as a URL. A validated
// top-level entry <title> is stored as display metadata only; missing
// titles are accepted, and invalid titles reject the feed without mutation.

import { validateTitle } from './titles.mjs';

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ATOM_NS = 'http://www.w3.org/2005/Atom';
const YT_NS = 'http://www.youtube.com/xml/schemas/2015';
const MEDIA_NS = 'http://search.yahoo.com/mrss/';
const XML_LANG = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
export const FEED_LIMIT = 1_000_000;
export const FETCH_TIMEOUT = 15_000;
export const DEFAULT_RETRY_SECONDS = 900;
export const MAX_RETRY_SECONDS = 3600;
const MAX_ENTRIES = 1000;
const FUTURE_SKEW = 5 * 60_000;
const PUBLISHED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const feedUrl = id => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;

const sanitize = value => String(value ?? '').replace(/<!--/g, '').slice(0, 300);

export function channelId(input) {
  let value = input;
  if (typeof value === 'string' && /^https:\/\//i.test(value)) {
    let parsed;
    try { parsed = new URL(value); }
    catch { throw new Error('Expected a YouTube channel ID (UC followed by 22 characters) or a https://www.youtube.com/channel/UC... URL'); }
    const match = /^\/channel\/(UC[A-Za-z0-9_-]{22})$/.exec(parsed.pathname);
    if (parsed.port || parsed.hostname !== 'www.youtube.com' || parsed.username || parsed.password ||
        parsed.search || parsed.hash || !match) {
      throw new Error('Expected a YouTube channel ID (UC followed by 22 characters) or a https://www.youtube.com/channel/UC... URL');
    }
    value = match[1];
  }
  if (typeof value !== 'string' || !CHANNEL_ID.test(value)) {
    throw new Error('Expected a YouTube channel ID (UC followed by 22 characters) or a https://www.youtube.com/channel/UC... URL');
  }
  return value;
}

export function ensureChannels(catalog) {
  catalog.channels ??= {};
  return catalog.channels;
}

function fail(message) {
  throw new Error(message);
}

// Decodes the five predefined entities plus numeric character references and
// rejects anything else. Text is only decoded for elements we actually read.
function decodeText(value) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#[xX][0-9a-fA-F]+;)/.test(value)) {
    fail('Feed contains an unsupported entity reference');
  }
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#[xX][0-9a-fA-F]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)) fail('Feed contains an invalid character reference');
      return String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body];
  });
}

// Minimal strict subset of XML sufficient for the canonical YouTube feed
// structure. Accepts the Atom namespace, the fixed YouTube `yt:` namespace,
// the declared canonical `media:` namespace (parsed structurally as ignored
// metadata), `xml:lang`, plain text, self-closing tags, and predefined and
// numeric entities. Rejects DOCTYPE, ENTITY, comments, CDATA, undeclared or
// rebound prefixes, xmlns declarations on non-root elements, and truncated
// markup. Nothing outside yt:channelId, yt:videoId, and published is read;
// the feed-root channelId may echo the channel's internal ID without the UC
// prefix, as live canonical feeds do, but must always resolve to the
// configured channel ID.
function parseAttributes(raw, index, element) {
  let i = index;
  const attributes = {};
  for (;;) {
    while (/[ \t\r\n]/.test(raw[i] ?? '')) i++;
    if (raw.startsWith('>', i)) return { attributes, index: i + 1 };
    if (raw.startsWith('/>', i)) return { attributes, index: i + 2, selfClosing: true };
    const name = /([A-Za-z_][\w.-]*)(?::([\w.-]+))?/y;
    name.lastIndex = i;
    const nameMatch = name.exec(raw);
    if (!nameMatch) fail(`Malformed attribute in <${element}>`);
    const [, head, tail = ''] = nameMatch;
    const attrName = tail ? `${head}:${tail}` : head;
    i = name.lastIndex;
    while (/[ \t\r\n]/.test(raw[i] ?? '')) i++;
    if (raw[i] !== '=') fail(`Malformed attribute in <${element}>`);
    i++;
    while (/[ \t\r\n]/.test(raw[i] ?? '')) i++;
    const quote = raw[i];
    if (quote !== '"' && quote !== "'") fail(`Malformed attribute in <${element}>`);
    const end = raw.indexOf(quote, i + 1);
    if (end === -1) fail(`Unterminated attribute in <${element}>`);
    const value = raw.slice(i + 1, end);
    if (/&(?![a-zA-Z#])/.test(value) || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#[xX][0-9a-fA-F]+;)/.test(value)) {
      fail(`Unsupported entity in attribute of <${element}>`);
    }
    if (Object.hasOwn(attributes, attrName)) fail(`Duplicate attribute in <${element}>`);
    attributes[attrName] = value;
    i = end + 1;
  }
}

export function parseFeed(raw, expectedChannelId, { now = Date.now() } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) fail('Feed must be nonempty text');
  if (Buffer.byteLength(raw) > FEED_LIMIT) fail('Feed exceeds 1 MiB');
  if (!CHANNEL_ID.test(expectedChannelId)) fail('Invalid expected channel ID');
  let i = 0;
  const declaration = /\s*<\?xml[\s\S]*?\?>\s*/y;
  declaration.lastIndex = 0;
  const head = declaration.exec(raw);
  if (head) i = declaration.lastIndex;
  const whitespace = /\s+/y;
  whitespace.lastIndex = i;
  if (whitespace.exec(raw)) i = whitespace.lastIndex;
  const rootOpen = /<feed(?=[\s/>])/y;
  rootOpen.lastIndex = i;
  if (!rootOpen.test(raw)) fail('Expected a <feed> root element');
  i = rootOpen.lastIndex;
  const root = parseAttributes(raw, i, 'feed');
  if (root.selfClosing) fail('Feed root element must not be self-closing');
  const declarations = {
    '': root.attributes.xmlns,
    yt: root.attributes['xmlns:yt'],
    media: root.attributes['xmlns:media'],
  };
  for (const [key, value] of Object.entries(root.attributes)) {
    if (key === 'xmlns' || key === 'xmlns:yt' || key === 'xmlns:media') continue;
    if (key === 'xml:lang') {
      if (!XML_LANG.test(value)) fail('Feed element has an invalid xml:lang attribute');
      continue;
    }
    fail(`Unsupported attribute ${key} on feed element`);
  }
  if (declarations[''] !== ATOM_NS) fail('Feed must declare the Atom namespace');
  if (declarations.yt !== YT_NS) fail('Feed must declare the YouTube channel namespace');
  if (declarations.media !== undefined && declarations.media !== MEDIA_NS) {
    fail('Feed must declare the canonical media namespace');
  }

  // Namespace declarations are only honored on the feed element; rebinding
  // them in child attributes is rejected so this parser never accepts feeds
  // that rebind Atom, yt, or media mid-document. The xml prefix is reserved
  // for xml:lang attributes.
  const checkAttributes = (attributes, element) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'xmlns' || key.startsWith('xmlns:')) {
        fail(`Namespace declarations are only supported on the feed element (in <${element}>)`);
      }
      const colon = key.indexOf(':');
      if (colon === -1) continue;
      const prefix = key.slice(0, colon);
      if (prefix === 'xml') {
        if (key !== 'xml:lang' || !XML_LANG.test(value)) fail(`Unsupported xml attribute ${key} in <${element}>`);
        continue;
      }
      if ((prefix !== 'yt' || declarations.yt !== YT_NS) &&
          (prefix !== 'media' || declarations.media !== MEDIA_NS)) {
        fail(`Undeclared attribute prefix ${prefix} in <${element}>`);
      }
    }
  };
  const elementPrefixOk = prefix =>
    prefix === '' ||
    (prefix === 'yt' && declarations.yt === YT_NS) ||
    (prefix === 'media' && declarations.media === MEDIA_NS);

  const stack = [{ name: 'feed', prefix: '', target: null, text: '', hasChildren: false }];
  const channelIds = [];
  const entries = [];
  let entry = null;
  const push = (name, prefix, selfClosing) => {
    const parent = stack.at(-1);
    if (!elementPrefixOk(prefix)) fail(`Unsupported element prefix ${prefix}`);
    if (parent && parent.target) parent.hasChildren = true;
    const isEntry = !prefix && name === 'entry' && stack.length === 1;
    let target = null;
    if (prefix === 'yt' && name === 'channelId' && stack.length === 1) target = 'channelId';
    else if (prefix === 'yt' && name === 'videoId' && entry && parent === entry.frame) target = 'videoId';
    else if (!prefix && name === 'published' && entry && parent === entry.frame) target = 'published';
    else if (!prefix && name === 'title' && entry && parent === entry.frame) target = 'title';
    const frame = { name, prefix, target, text: '', hasChildren: false };
    stack.push(frame);
    if (isEntry) {
      if (entry) fail('Nested entry elements are not supported');
      entry = { frame, videoIds: [], published: null };
    }
    if (selfClosing) close(true);
  };
  const close = selfClosing => {
    const frame = stack.at(-1);
    if (!frame) fail('Feed closes an element that was never opened');
    stack.pop();
    if (frame.target) {
      if (frame.hasChildren) fail(`<${frame.name}> must not contain nested elements`);
      const text = decodeText(frame.text).trim();
      if (frame.target === 'channelId') {
        // Live canonical feeds echo the channel's internal ID without the
        // "UC" prefix on the feed root, while entries carry the full ID.
        // Both forms map to the one validated configured ID; anything else
        // is rejected.
        if (text !== expectedChannelId && 'UC' + text !== expectedChannelId) {
          fail('Feed contains an invalid channel ID');
        }
        channelIds.push(text);
      } else if (frame.target === 'videoId') {
        if (!VIDEO_ID.test(text)) fail('Feed contains an invalid video ID');
        entry.videoIds.push(text);
      } else if (frame.target === 'title') {
        try { entry.title = validateTitle(text, 'feed entry title'); }
        catch (error) { fail(`Feed entry has an invalid title: ${error.message}`); }
      } else if (frame.target === 'published') {
        if (!PUBLISHED.test(text) || !Number.isFinite(Date.parse(text))) {
          fail('Feed entry has an invalid published timestamp');
        }
        if (Date.parse(text) > now + FUTURE_SKEW) fail('Feed entry published timestamp is in the future');
        entry.published = text;
      } else if (text === '' && !selfClosing) {
        fail(`<${frame.name}> must not be empty`);
      }
    }
  };
  while (i < raw.length) {
    const start = raw.indexOf('<', i);
    if (start === -1) {
      if (stack.length) stack.at(-1).text += raw.slice(i);
      else if (raw.slice(i).trim()) fail('Feed has content outside the root element');
      i = raw.length;
      continue;
    }
    if (start > i) {
      const text = raw.slice(i, start);
      if (!stack.length) {
        if (text.trim()) fail('Feed has content outside the root element');
      } else {
        if (text.includes(']]>')) fail('Feed contains forbidden CDATA close marker');
        stack.at(-1).text += text;
      }
    }
    if (!stack.length && !/[ \t\r\n]/.test(raw[i]) && raw[i] !== '<') {
      fail('Feed has content outside the root element');
    }
    i = start;
    if (raw.startsWith('</', i)) {
      const name = /<\/([A-Za-z_][\w.-]*)(?::([\w.-]+))?>/y;
      name.lastIndex = i;
      const match = name.exec(raw);
      if (!match) fail('Malformed close tag');
      const [, head, tail = ''] = match;
      const prefix = tail ? head : '';
      const local = tail || head;
      const frame = stack.at(-1);
      if (!frame || frame.name !== local || frame.prefix !== prefix) {
        fail('Feed markup is malformed or truncated');
      }
      if (!elementPrefixOk(prefix)) fail(`Unsupported element prefix ${prefix}`);
      i = name.lastIndex;
      if (local === 'entry' && frame.prefix === '') {
        if (!entry || entry.frame !== frame) fail('Malformed entry structure');
        if (!entry.videoIds.length) fail('Feed entry has no yt:videoId');
        if (new Set(entry.videoIds).size !== 1) fail('Feed entry has conflicting video IDs');
        if (!entry.published) fail('Feed entry has no published timestamp');
        entries.push({ videoId: entry.videoIds[0], published: entry.published, ...(entry.title === undefined ? {} : { title: entry.title }) });
        entry = null;
      }
      close(false);
    } else if (raw.startsWith('<?', i) || raw.startsWith('<!', i)) {
      fail('Feed contains a declaration, comment, DOCTYPE, or processing instruction, which are not accepted');
    } else {
      const name = /<([A-Za-z_][\w.-]*)(?::([\w.-]+))?/y;
      name.lastIndex = i;
      const match = name.exec(raw);
      if (!match) fail('Malformed open tag');
      const [, head, tail = ''] = match;
      const prefix = tail ? head : '';
      const local = tail || head;
      if (!elementPrefixOk(prefix)) fail(`Unsupported element prefix ${prefix}`);
      i = name.lastIndex;
      const parsed = parseAttributes(raw, i, local);
      checkAttributes(parsed.attributes, local);
      push(local, prefix, parsed.selfClosing);
      i = parsed.index;
    }
  }
  if (stack.length) fail('Feed is truncated or malformed');
  if (!channelIds.length) fail('Feed has no yt:channelId');
  if (channelIds.some(id => id !== expectedChannelId && 'UC' + id !== expectedChannelId)) {
    fail('Feed channel ID does not match the configured channel');
  }
  if (entries.length > MAX_ENTRIES) fail('Feed has too many entries');
  return { channelId: expectedChannelId, entries };
}

// First successful poll baselines the finite feed and queues nothing unless
// --backfill was explicit. Explicit backfill queues every currently returned
// feed ID missing from catalog.videos, regardless of seen membership, and
// never rewrites existing video state. Regular polls queue only unseen IDs;
// seen IDs stay retained so replays never re-queue. Existing videos keep
// their state and transcript. Coverage claims nothing about history beyond
// what the feed currently returns.
export function applyFeed(catalog, record, entries, { backfill = false, now = Date.now() } = {}) {
  const timestamp = new Date(now).toISOString();
  const seen = new Set(record.seenVideoIds ?? []);
  let queued = 0;
  if (!record.initialized && !backfill) {
    for (const { videoId } of entries) seen.add(videoId);
  } else {
    for (const { videoId, title } of entries) {
      const exists = Object.hasOwn(catalog.videos, videoId);
      if (!backfill) {
        if (seen.has(videoId)) continue;
        seen.add(videoId);
        if (exists) continue;
      } else {
        seen.add(videoId);
        if (exists) continue;
      }
      catalog.videos[videoId] = {
        id: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        state: 'queued',
        channelId: record.id,
        discoveredAt: timestamp,
        ...(title === undefined ? {} : { title }),
      };
      queued++;
    }
  }
  record.seenVideoIds = [...seen];
  record.initialized = true;
  record.lastCheckedAt = timestamp;
  record.state = 'ready';
  delete record.reason;
  delete record.retryAfter;
  return queued;
}

export function retryAfterFrom(header, now = Date.now()) {
  let seconds = DEFAULT_RETRY_SECONDS;
  if (typeof header === 'string' && header.trim()) {
    const numeric = /^(\d+)$/.exec(header.trim());
    if (numeric) seconds = Number(numeric[1]);
    else {
      const parsed = Date.parse(header);
      if (Number.isFinite(parsed)) seconds = Math.max(0, Math.round((parsed - now) / 1000));
    }
  }
  seconds = Math.min(Math.max(seconds, 0), MAX_RETRY_SECONDS);
  return new Date(now + seconds * 1000).toISOString();
}

// Fetches one fixed URL built from a validated channel ID. No cookies, no
// redirects, 15-second timeout, streamed body bounded at 1 MiB. Unused or
// oversized response bodies are canceled to release connections.
export async function fetchChannelFeed(id, fetchImpl = globalThis.fetch, { now = Date.now() } = {}) {
  if (!CHANNEL_ID.test(id)) throw new Error('Invalid channel ID');
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available for feed retrieval');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const discard = async response => { try { await response.body?.cancel?.(); } catch { /* best effort */ } };
  try {
    let response;
    try {
      response = await fetchImpl(feedUrl(id), { redirect: 'error', signal: controller.signal, credentials: 'omit' });
    } catch (error) {
      if (error?.name === 'AbortError') return { state: 'failed', reason: 'Feed request timed out after 15 seconds' };
      return { state: 'failed', reason: `Feed request failed: ${sanitize(error?.message)}` };
    }
    if (response.status === 429) {
      await discard(response);
      return { state: 'rate_limited', retryAfter: retryAfterFrom(response.headers.get('retry-after'), now) };
    }
    if (!response.ok) {
      await discard(response);
      return { state: 'failed', reason: `Feed request returned HTTP ${response.status}` };
    }
    const reader = response.body?.getReader?.();
    if (!reader) return { state: 'failed', reason: 'Feed response has no readable body' };
    const chunks = [];
    let size = 0;
    for (;;) {
      let read;
      try { read = await reader.read(); }
      catch (error) { return { state: 'failed', reason: `Feed stream failed: ${sanitize(error?.message)}` }; }
      if (read.done) break;
      const chunk = read.value;
      size += chunk.byteLength;
      if (size > FEED_LIMIT) {
        await reader.cancel().catch(() => {});
        return { state: 'failed', reason: 'Feed exceeds 1 MiB' };
      }
      chunks.push(chunk);
    }
    return { state: 'ok', body: Buffer.concat(chunks).toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

// Polls every configured channel once. A failed or rate-limited channel
// records its state without advancing its baseline or seen set; a
// rate-limited channel is skipped, not hammered, until its cooldown ends.
// The caller persists the catalog so successes from other channels survive.
export async function discover(catalog, { fetch, now = Date.now(), backfill = false } = {}) {
  const channels = ensureChannels(catalog);
  const results = [];
  for (const id of Object.keys(channels)) {
    const record = channels[id];
    if (record.retryAfter && Date.parse(record.retryAfter) > now) {
      results.push({ id, state: 'failed', skipped: true, reason: record.reason ?? 'Feed cooldown active', retryAfter: record.retryAfter });
      continue;
    }
    const outcome = await fetchChannelFeed(id, fetch, { now });
    if (outcome.state === 'ok') {
      try {
        const feed = parseFeed(outcome.body, id, { now });
        const queued = applyFeed(catalog, record, feed.entries, { backfill, now });
        results.push({ id, state: 'ready', queued, seenVideoIds: record.seenVideoIds.length });
      } catch (error) {
        record.state = 'failed';
        record.reason = sanitize(`Feed rejected: ${error.message}`);
        results.push({ id, state: 'failed', reason: record.reason });
      }
    } else if (outcome.state === 'rate_limited') {
      record.state = 'failed';
      record.retryAfter = outcome.retryAfter;
      record.reason = sanitize(`Feed request rate limited (HTTP 429). Retry after ${outcome.retryAfter}`);
      results.push({ id, state: 'failed', reason: record.reason, retryAfter: outcome.retryAfter });
    } else {
      record.state = 'failed';
      record.reason = sanitize(outcome.reason);
      results.push({ id, state: 'failed', reason: record.reason });
    }
  }
  return results;
}
