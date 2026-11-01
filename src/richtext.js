// -----------------------------------------------------------------------------
// Text in and out of Bluesky.
//
// Posts and direct messages are plain text plus "rich text facets"
// (app.bsky.richtext.facet): ranges of the text that are a link, a mention
// (resolved to a DID) or a hashtag. The ranges are BYTE offsets in the UTF-8
// encoding of the text, start inclusive, end exclusive (docs.bsky.app,
// "Links, mentions, and rich text"): never JavaScript string indexes.
//
// Limits counted in graphemes (Intl.Segmenter), as the lexicons say:
//   - a post: 300 graphemes (app.bsky.feed.post, maxGraphemes 300) and 3,000
//     bytes;
//   - a direct message: 1,000 graphemes and 10,000 bytes
//     (chat.bsky.convo.defs#messageInput).
//
// Detection follows the example parsers of the docs: links only when written
// with http:// or https:// (no list of top-level domains to keep up to date),
// mentions of a valid handle, hashtags of up to 64 characters not starting
// with a digit.
// -----------------------------------------------------------------------------

const MAX_POST_GRAPHEMES = 300;
const MAX_POST_BYTES = 3000;
const MAX_DM_GRAPHEMES = 1000;
const MAX_DM_BYTES = 10_000;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const encoder = new TextEncoder();

/**
 * @description The graphemes of a text (what a reader counts as characters).
 * @param {string} value - The text.
 * @returns {string[]} The graphemes.
 */
const graphemes = (value) => [...segmenter.segment(String(value ?? ''))].map((s) => s.segment);

/**
 * @description The number of graphemes of a text.
 * @param {string} value - The text.
 * @returns {number} The count.
 * @example
 * graphemeLength('👨‍👩‍👧 ok'); // -> 4
 */
const graphemeLength = (value) => graphemes(value).length;

/**
 * @description The UTF-8 length of a text.
 * @param {string} value - The text.
 * @returns {number} Bytes.
 */
const byteLength = (value) => encoder.encode(String(value ?? '')).byteLength;

/**
 * @description Cut a text to a number of graphemes and bytes, with … when cut.
 * @param {string} value - The text.
 * @param {number} maxGraphemes - The limit in graphemes.
 * @param {number} [maxBytes] - The limit in bytes.
 * @returns {{ text: string, truncated: boolean }} The text.
 */
function truncate(value, maxGraphemes, maxBytes = Infinity) {
  const text = String(value ?? '');
  const parts = graphemes(text);
  if (parts.length <= maxGraphemes && byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }
  const kept = [];
  let bytes = byteLength('…');
  for (const part of parts.slice(0, maxGraphemes - 1)) {
    bytes += byteLength(part);
    if (bytes > maxBytes) break;
    kept.push(part);
  }
  return { text: `${kept.join('').trimEnd()}…`, truncated: true };
}

/**
 * @description Cut a long text in parts of a direct message, at a line or a
 * space when it can.
 * @param {string} value - The text.
 * @param {number} [max] - Graphemes per part.
 * @returns {string[]} The parts (none for an empty text).
 */
function splitMessage(value, max = MAX_DM_GRAPHEMES) {
  const parts = [];
  let rest = graphemes(String(value ?? '').trim());
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n');
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).join('').trimEnd());
    rest = graphemes(rest.slice(cut).join('').trimStart());
  }
  const last = rest.join('');
  if (last) {
    parts.push(last);
  }
  return parts;
}

/**
 * @description A UTF-16 index of a string as a UTF-8 byte offset.
 * @param {string} text - The text.
 * @param {number} index - The UTF-16 index.
 * @returns {number} The byte offset.
 */
const byteOffset = (text, index) => byteLength(text.slice(0, index));

const HANDLE_PART =
  /([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?/;
const MENTION = new RegExp(`(^|\\s|\\()@(${HANDLE_PART.source})`, 'g');
const LINK = /(^|\s|\()(https?:\/\/\S+)/gi;
const TAG = /(^|\s)(#[^\d\s]\S*)/gu;

/**
 * @description The facets of a text, mentions resolved to DIDs.
 * @param {string} text - The text.
 * @param {(handle: string) => Promise<string|null>} [resolve] - Handle -> DID
 *   (a handle that does not resolve stays plain text).
 * @returns {Promise<object[]>} The facets, sorted, never overlapping.
 * @example
 * await detectFacets('Hi @alice.bsky.social https://gladysassistant.com #home', resolve);
 */
async function detectFacets(text, resolve = async () => null) {
  const value = String(text ?? '');
  const found = [];
  for (const match of value.matchAll(MENTION)) {
    const start = match.index + match[1].length;
    const handle = match[2].replace(/\.$/, '');
    found.push({ start, end: start + 1 + handle.length, kind: 'mention', handle });
  }
  for (const match of value.matchAll(LINK)) {
    let uri = match[2];
    const start = match.index + match[1].length;
    // Ending punctuation is not part of the link.
    uri = uri.replace(/[.,;:!?'"]+$/, '');
    if (uri.endsWith(')') && !uri.includes('(')) uri = uri.slice(0, -1);
    try {
      new URL(uri);
    } catch {
      continue;
    }
    found.push({ start, end: start + uri.length, kind: 'link', uri });
  }
  for (const match of value.matchAll(TAG)) {
    const tag = match[2].replace(/\p{P}+$/u, '');
    const start = match.index + match[1].length;
    if (tag.length < 2 || graphemeLength(tag.slice(1)) > 64) continue;
    found.push({ start, end: start + tag.length, kind: 'tag', tag: tag.slice(1) });
  }
  found.sort((a, b) => a.start - b.start);
  const facets = [];
  let last = -1;
  for (const item of found) {
    if (item.start < last) continue; // facets never overlap
    let feature;
    if (item.kind === 'mention') {
      const did = await resolve(item.handle.toLowerCase()).catch(() => null);
      if (!did) continue;
      feature = { $type: 'app.bsky.richtext.facet#mention', did };
    } else if (item.kind === 'link') {
      feature = { $type: 'app.bsky.richtext.facet#link', uri: item.uri };
    } else {
      feature = { $type: 'app.bsky.richtext.facet#tag', tag: item.tag };
    }
    facets.push({
      index: { byteStart: byteOffset(value, item.start), byteEnd: byteOffset(value, item.end) },
      features: [feature],
    });
    last = item.end;
  }
  return facets;
}

// --- AT URIs and bsky.app links ------------------------------------------------------

const AT_URI =
  /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+|[a-zA-Z0-9.-]+)\/([a-zA-Z0-9.]+)\/([a-zA-Z0-9._:~-]{1,512})$/;
const WEB_POST =
  /^https:\/\/bsky\.app\/profile\/([^/?#]+)\/post\/([a-zA-Z0-9._:~-]{1,512})\/?(?:[?#].*)?$/;

/**
 * @description The parts of an AT URI (at://<repo>/<collection>/<rkey>).
 * @param {string} uri - The URI.
 * @returns {{ repo: string, collection: string, rkey: string }|null} The parts.
 */
function parseAtUri(uri) {
  const match = AT_URI.exec(String(uri ?? '').trim());
  return match ? { repo: match[1], collection: match[2], rkey: match[3] } : null;
}

/**
 * @description A post typed by a user: its AT URI or its bsky.app link.
 * @param {string} value - The value.
 * @returns {{ repo: string, rkey: string }|null} The post (repo: DID or handle).
 * @example
 * readPostRef('https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l');
 */
function readPostRef(value) {
  const raw = String(value ?? '').trim();
  const web = WEB_POST.exec(raw);
  if (web) {
    return { repo: decodeURIComponent(web[1]).toLowerCase(), rkey: web[2] };
  }
  const at = parseAtUri(raw);
  return at && at.collection === 'app.bsky.feed.post' ? { repo: at.repo, rkey: at.rkey } : null;
}

/**
 * @description The bsky.app link of a post.
 * @param {string} uri - The AT URI of the post.
 * @param {string} [handle] - The handle of its author (else the DID of the URI).
 * @returns {string} The link, '' when not a post.
 * @example
 * postUrl('at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l', 'bsky.app');
 * // -> 'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l'
 */
function postUrl(uri, handle) {
  const parts = parseAtUri(uri);
  if (!parts || parts.collection !== 'app.bsky.feed.post') {
    return '';
  }
  const who = handle && handle !== 'handle.invalid' ? handle : parts.repo;
  return `https://bsky.app/profile/${who}/post/${parts.rkey}`;
}

/**
 * @description The bsky.app link of a profile.
 * @param {string} actor - Handle or DID.
 * @returns {string} The link.
 */
const profileUrl = (actor) => (actor ? `https://bsky.app/profile/${actor}` : '');

/**
 * @description Shorten a text for a widget or an event (code units).
 * @param {string} value - The text.
 * @param {number} max - The maximum length.
 * @returns {string} The text, with … when cut.
 */
function shorten(value, max) {
  const plain = String(value ?? '');
  if (plain.length <= max) {
    return plain;
  }
  // Never cut a surrogate pair in two.
  const cut = plain.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut}…`;
}

export {
  MAX_POST_GRAPHEMES,
  MAX_POST_BYTES,
  MAX_DM_GRAPHEMES,
  MAX_DM_BYTES,
  graphemeLength,
  byteLength,
  truncate,
  splitMessage,
  detectFacets,
  parseAtUri,
  readPostRef,
  postUrl,
  profileUrl,
  shorten,
};
