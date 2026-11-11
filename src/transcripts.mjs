const RAW_HTML_LIMIT = 5_000_000;
const TRANSCRIPT_LIMIT = 2_000_000;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function attrValue(attrs, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
}

function readTagAt(html, start) {
  let i = start + 1;
  let closing = false;
  if (html[i] === '/') { closing = true; i++; }
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(i, i + 64));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  i += name.length;
  const attrsStart = i;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '"' || ch === "'") {
      const endQuote = html.indexOf(ch, i + 1);
      if (endQuote === -1) throw new Error('Malformed transcript: truncated tag');
      i = endQuote + 1;
      continue;
    }
    if (ch === '>') break;
    i++;
  }
  if (i >= html.length) throw new Error('Malformed transcript: truncated tag');
  let attrs = html.slice(attrsStart, i).trim();
  let selfClose = false;
  if (attrs.endsWith('/')) { selfClose = true; attrs = attrs.slice(0, -1).trim(); }
  return { name, closing, selfClose, attrs, end: i + 1 };
}

function findElement(html, openEnd, name, limit = html.length) {
  let depth = 1;
  let i = openEnd;
  while (i < limit) {
    const lt = html.indexOf('<', i);
    if (lt === -1 || lt >= limit) throw new Error(`Malformed transcript: unclosed <${name}>`);
    const tag = readTagAt(html, lt);
    if (!tag) { i = lt + 1; continue; }
    if (tag.name === name && !tag.selfClose && !VOID_ELEMENTS.has(tag.name)) {
      if (tag.closing) { depth--; if (depth === 0) return { closeStart: lt, closeEnd: tag.end }; }
      else depth++;
    }
    i = tag.end;
  }
  throw new Error(`Malformed transcript: unclosed <${name}>`);
}

function collectText(html, start, end) {
  let out = '';
  let i = start;
  while (i < end) {
    const lt = html.indexOf('<', i);
    if (lt === -1 || lt >= end) { out += html.slice(i, end); break; }
    out += html.slice(i, lt);
    const tag = readTagAt(html, lt);
    if (!tag) { out += '<'; i = lt + 1; continue; }
    if (tag.closing || tag.selfClose || VOID_ELEMENTS.has(tag.name)) { i = tag.end; continue; }
    const child = findElement(html, tag.end, tag.name, end);
    out += collectText(html, tag.end, child.closeStart);
    i = child.closeEnd;
  }
  return out;
}

function findFirstOpen(html, start, end, name) {
  let i = start;
  while (i < end) {
    const lt = html.indexOf('<', i);
    if (lt === -1 || lt >= end) return undefined;
    const tag = readTagAt(html, lt);
    if (!tag) { i = lt + 1; continue; }
    if (!tag.closing && !tag.selfClose && tag.name === name) return tag;
    i = tag.end;
  }
  return undefined;
}

function modernText(html, start, end) {
  let i = start;
  while (i < end) {
    const lt = html.indexOf('<', i);
    if (lt === -1 || lt >= end) break;
    const tag = readTagAt(html, lt);
    if (!tag) { i = lt + 1; continue; }
    if (!tag.closing && !tag.selfClose && tag.name === 'span' && attrValue(tag.attrs, 'role')?.toLowerCase() === 'text') {
      const close = findElement(html, tag.end, 'span', end);
      return collectText(html, tag.end, close.closeStart);
    }
    i = tag.end;
  }
  throw new Error('Malformed transcript segment: no <span role="text">');
}

function legacyText(html, start, end) {
  let i = start;
  while (i < end) {
    const lt = html.indexOf('<', i);
    if (lt === -1 || lt >= end) break;
    const tag = readTagAt(html, lt);
    if (!tag) { i = lt + 1; continue; }
    if (!tag.closing && !tag.selfClose && ((attrValue(tag.attrs, 'class') ?? '').split(/\s+/).includes('segment-text'))) {
      const close = findElement(html, tag.end, tag.name, end);
      const inner = findFirstOpen(html, tag.end, close.closeStart, 'yt-formatted-string');
      if (inner) {
        const innerClose = findElement(html, inner.end, inner.name, close.closeStart);
        return collectText(html, inner.end, innerClose.closeStart);
      }
      return collectText(html, tag.end, close.closeStart);
    }
    i = tag.end;
  }
  throw new Error('Malformed transcript segment: no .segment-text');
}

function stripComments(html) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = html.indexOf('<!--', i);
    if (start === -1) return out + html.slice(i);
    const end = html.indexOf('-->', start + 4);
    if (end === -1) throw new Error('Malformed transcript: unterminated comment');
    out += html.slice(i, start);
    i = end + 3;
  }
}

function stripElements(html, name) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return out + html.slice(i);
    const tag = readTagAt(html, lt);
    if (!tag || tag.closing || tag.name !== name) {
      out += html.slice(i, lt + 1);
      i = lt + 1;
      continue;
    }
    if (tag.selfClose || VOID_ELEMENTS.has(tag.name)) { i = tag.end; continue; }
    const close = findElement(html, tag.end, name);
    i = close.closeEnd;
  }
  return out;
}

export function decodeEntities(value) {
  return value.replace(/&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (match, hex, dec, name) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      if (code >= 1 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
      return match;
    }
    if (dec !== undefined) {
      const code = Number.parseInt(dec, 10);
      if (code >= 1 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
      return match;
    }
    return name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : match;
  });
}

// Parses a saved YouTube transcript page into plain text. Treats the HTML as
// inert text: no evaluation, no resource loading, no network. Only text inside
// modern <transcript-segment-view-model> <span role="text"> elements or legacy
// <ytd-transcript-segment-renderer> .segment-text content is extracted, in
// document order. Script, style, and comment content is discarded, so markup
// faked inside them never becomes transcript text. Truncated or malformed
// transcript segments are rejected instead of yielding a partial transcript.
// Well-formed HTML with no transcript segments yields ''.
export function parseHtmlTranscript(raw) {
  if (typeof raw !== 'string') throw new Error('Transcript HTML must be decoded text');
  if (Buffer.byteLength(raw, 'utf8') > RAW_HTML_LIMIT) throw new Error('Transcript HTML exceeds 5 MB');
  let html = stripComments(raw);
  for (const name of ['script', 'style']) html = stripElements(html, name);
  const segmentPattern = /<(transcript-segment-view-model|ytd-transcript-segment-renderer)(?=[\s/>])/gi;
  const lines = [];
  let match;
  segmentPattern.lastIndex = 0;
  while ((match = segmentPattern.exec(html)) !== null) {
    const modern = match[1].toLowerCase() === 'transcript-segment-view-model';
    const open = readTagAt(html, match.index);
    const segment = findElement(html, open.end, open.name);
    const body = modern ? modernText(html, open.end, segment.closeStart) : legacyText(html, open.end, segment.closeStart);
    const line = decodeEntities(body).replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
    segmentPattern.lastIndex = segment.closeEnd;
  }
  const transcript = lines.join('\n');
  if (Buffer.byteLength(transcript, 'utf8') > TRANSCRIPT_LIMIT) throw new Error('Decoded transcript exceeds 2 MB');
  return transcript;
}
