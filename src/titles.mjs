// Public title handling: validation at the boundary and Windows-safe,
// lowercased source-note filename bases. Internal identity stays the exact
// YouTube video ID; titles and slugs are display metadata only.
export const TITLE_LIMIT = 500;
export const SLUG_LIMIT = 80;
const MARKER = /<!--\s*auditor:generated:/i;
const CONTROL = /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const FALLBACK_SLUG = 'untitled-video';
export const untitledPattern = /^untitled-video(?:-\d+)?$/;

export function isTitleUnavailable(video) {
  return !(video && typeof video.title === 'string' && video.title.trim());
}

export function validateTitle(value, field = 'title') {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}: expected a string`);
  const title = value.trim();
  if (!title) throw new Error(`Invalid ${field}: must be nonempty`);
  if (title.length > TITLE_LIMIT) throw new Error(`Invalid ${field}: exceeds ${TITLE_LIMIT} characters`);
  if (CONTROL.test(title)) throw new Error(`Invalid ${field}: must be a single line without control characters`);
  if (MARKER.test(title)) throw new Error(`Invalid ${field}: must not contain an auditor generated section marker`);
  return title;
}

// Lowercase ASCII filename base for a validated title. Returns null when no
// safe base can be formed (for example a non-ASCII-only title); callers use
// a descriptive numbered fallback instead of inventing a Unicode path.
export function titleBase(title) {
  if (typeof title !== 'string') return null;
  let base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base.length > SLUG_LIMIT) base = base.slice(0, SLUG_LIMIT).replace(/-+$/, '');
  if (!base || !slugPattern.test(base)) return null;
  if (RESERVED.test(base)) base = `video-${base}`;
  return base;
}
