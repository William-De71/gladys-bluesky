// -----------------------------------------------------------------------------
// The optional image of a post (scene action publish_post, field image_url):
// downloaded from an http(s) URL, checked (JPEG, PNG, WebP or GIF, 2,000,000
// bytes at most: the `maxSize` of app.bsky.embed.images#image), then uploaded
// with com.atproto.repo.uploadBlob. Its size gives the `aspectRatio` of the
// embed, so the apps draw it without cropping.
// -----------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;

/**
 * @description The type and size of an image, from its first bytes.
 * @param {Buffer} bytes - The image.
 * @returns {{ bytes: Buffer, mime: string, width: number|null, height: number|null }} The image.
 * @throws {Error} When it is not an accepted image.
 */
function readImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16) {
    throw new Error('image_url: not an image');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`image_url: ${bytes.length} bytes, Bluesky accepts ${MAX_IMAGE_BYTES} at most`);
  }
  if (bytes.toString('latin1', 1, 4) === 'PNG') {
    return {
      bytes,
      mime: 'image/png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (bytes.toString('latin1', 0, 4) === 'GIF8') {
    return {
      bytes,
      mime: 'image/gif',
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
    };
  }
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    let size = { width: null, height: null };
    if (chunk === 'VP8X' && bytes.length >= 30) {
      size = { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    } else if (chunk === 'VP8 ' && bytes.length >= 30) {
      size = { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    } else if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      size = { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { bytes, mime: 'image/webp', ...size };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the JPEG segments up to a start of frame (SOF0…SOF15, not DHT/JPG/DAC).
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          bytes,
          mime: 'image/jpeg',
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + length;
    }
    return { bytes, mime: 'image/jpeg', width: null, height: null };
  }
  throw new Error('image_url: JPEG, PNG, WebP or GIF only');
}

/**
 * @description Download an image (http or https only, no redirect to
 * anything else, 2,000,000 bytes at most).
 * @param {string} url - The URL.
 * @param {object} [options] - Options.
 * @param {Function} [options.fetchImpl] - fetch.
 * @returns {Promise<Buffer>} The bytes.
 */
async function fetchImage(url, { fetchImpl = (...args) => fetch(...args) } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('image_url: not a URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('image_url: an http:// or https:// URL without credentials');
  }
  let response;
  try {
    response = await fetchImpl(parsed, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`image_url: unreachable (${err?.cause?.code ?? err.name})`, { cause: err });
  }
  if (!response.ok) {
    throw new Error(`image_url: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`image_url: ${declared} bytes, Bluesky accepts ${MAX_IMAGE_BYTES} at most`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes;
}

export { MAX_IMAGE_BYTES, readImage, fetchImage };
