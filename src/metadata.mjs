// Manual title capture from YouTube's fixed official oEmbed endpoint,
// derived only from a validated video ID. Public metadata only: no cookies,
// no redirects, a 10-second timeout, and a 1 MiB response body cap.
import { validateTitle } from './titles.mjs';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const OEMBED_TIMEOUT = 10_000;
export const OEMBED_LIMIT = 1_000_000;

export const oembedUrl = id => {
  if (!VIDEO_ID.test(id ?? '')) throw new Error('Invalid video ID');
  return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
};

export function storeTitle(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('oEmbed response is not an object');
  try { return { id: data.id ?? null, title: validateTitle(data.title, 'oEmbed title') }; }
  catch (error) { throw new Error(`oEmbed payload rejected: ${error.message}`); }
}

export async function fetchVideoTitle(id, fetchImpl = globalThis.fetch) {
  const url = oembedUrl(id);
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available for metadata retrieval');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OEMBED_TIMEOUT);
  const sanitize = value => String(value ?? '').replace(/<!--/g, '').slice(0, 4000);
  try {
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'error', signal: controller.signal, credentials: 'omit' });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Metadata request timed out after 10 seconds');
      throw new Error(`Metadata request failed: ${sanitize(error?.message)}`);
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`Metadata request returned HTTP ${response.status}`);
    }
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error('Metadata response has no readable body');
    const chunks = [];
    let size = 0;
    for (;;) {
      let read;
      try { read = await reader.read(); }
      catch (error) { throw new Error(`Metadata stream failed: ${sanitize(error?.message)}`); }
      if (read.done) break;
      size += read.value.byteLength;
      if (size > OEMBED_LIMIT) { await reader.cancel().catch(() => {}); throw new Error('Metadata response exceeds 1 MiB'); }
      chunks.push(read.value);
    }
    let data;
    const body = Buffer.concat(chunks).toString('utf8');
    try { data = JSON.parse(body); }
    catch { throw new Error('Metadata response is not valid JSON'); }
    return storeTitle({ id, title: data?.title });
  } finally {
    clearTimeout(timer);
  }
}
