import {
  convertIndexedToRgb,
  decode as decodePng,
  encode as encodePng,
  type DecodedPng,
} from 'fast-png';
import { PixelBuffer } from './buffer.js';

/**
 * PNG is the lingua franca of the whole product: it is the export format, the format
 * cels are stored in inside `.pixel`, and — crucially — the format MCP resources hand
 * to a multimodal model so it can actually *see* what it drew.
 *
 * Decoding is deliberately broad: indexed PNGs, greyscale, sub-byte bit depths and
 * 16-bit channels all land in the same RGBA8888 buffer.
 */

export interface PngEncodeOptions {
  /** zlib level 0-9. Higher is smaller and slower. Defaults to the library's own default. */
  level?: number;
  /**
   * PNG `tEXt` chunks, keyword to text.
   *
   * **Provenance, not pixels.** Nothing here changes a single pixel, which is the whole reason
   * it is safe: a shared file carrying these chunks decodes to byte-identical RGBA, so the asset
   * underneath a badge is still recoverable. See `PNG_PROVENANCE_KEYS` for the vocabulary the
   * product itself writes, and for what is deliberately refused.
   */
  metadata?: Record<string, string>;
}

/**
 * The keywords this product writes into a PNG's text chunks, and what each one is allowed to say.
 *
 * **The rule that decides membership: a text chunk is a declaration *about* the file, so it may
 * carry only what is (a) true of these bytes and (b) the same on every machine.** `ASSET-CONTRACT`
 * S4.2 draws the same line for the content hash - "a direction is a declaration *about* the asset"
 * - and S4.4 says what the hash is not: a cache key, never an authenticity claim. So:
 *
 * | key | carries | why it is allowed |
 * | --- | --- | --- |
 * | `Software` | `dotloom-mcp` | The made-with badge, as the PNG spec's own keyword for it. **No version**: S10 rejected a generated-by block with a version because it makes every committed artifact a diff on upgrade. |
 * | `dotloom:asset` | `sha256:...` | The asset identity from the contract. It is what lets a consumer recognise the file without re-compositing every frame, and it changes exactly when the artwork does. |
 * | `dotloom:name` | the asset name | A lookup key, outside the hash by S4.1 so a rename invalidates no cache. Putting it in a chunk invalidates nothing, because no chunk is hashed. |
 * | `dotloom:contract` | `dotloom-mcp/asset-meta` | The S5 `format` role: says this is an asset contract rather than an export manifest or an Aseprite sheet JSON. |
 * | `dotloom:schema` | the contract schemaVersion | Additive within a major version (S3 rule 2), so this moves only when the digest could. |
 * | `dotloom:license` | an SPDX id | The one declaration the document model cannot hold. **Written only when the caller supplied it**, never inferred - S11 "never invent what the document does not know". |
 * | `dotloom:defects` | sorted defect **codes** | The honest channel. Names survive being ignored; see `PNG_METADATA_FORBIDDEN_KEYS` for why no number does. |
 *
 * **And what is refused, which is the load-bearing half.** `PNG_METADATA_FORBIDDEN_KEYS` rejects
 * a score-shaped key at the point of writing rather than in a review, because the one thing this
 * repository deleted in 0.3.1 was a tool that published a number and watched a model sand a lake
 * flat to keep it clean. A text chunk travels - it survives being pasted, mailed and re-saved by
 * a person who never opens it - which makes it the last place a number should be allowed to hide.
 */
export const PNG_PROVENANCE_KEYS = [
  'Software',
  'dotloom:asset',
  'dotloom:name',
  'dotloom:contract',
  'dotloom:schema',
  'dotloom:license',
  'dotloom:defects',
] as const;

/**
 * A key or a value naming a verdict. Matched case-insensitively over the whole string, so
 * `score`, `ScoreQ`, `quality_score` and `final-grade` are all refused.
 *
 * The pattern is the same one `packages/core/test/gallery.test.ts` walks its JSON with, used here
 * as a *guard on the writer* rather than as a test after the fact: a key this rejects cannot reach
 * a shared file in the first place.
 */
export const PNG_METADATA_FORBIDDEN_KEYS = /score|grade|rating|percent|verdict|quality/i;

/**
 * Write `metadata` into a PNG's text chunks, refusing anything this repository has decided must
 * never travel with an image.
 *
 * Three refusals, all loud, because the alternative is a corrupt or misleading file:
 *
 *   - a **non-Latin-1** value. `tEXt` is Latin-1 by specification and `fast-png` will throw deep
 *     inside the encoder otherwise; an asset named in Japanese or emoji would fail at the last
 *     possible moment with a message naming a chunk.
 *   - a **verdict-shaped key**. See `PNG_METADATA_FORBIDDEN_KEYS`.
 *   - a **bare number** under any key but `dotloom:schema`. See the note at the check.
 *
 * Keys are written in sorted order so the same input produces the same bytes (S11 rule 3).
 */
export function assertPngMetadata(metadata: Record<string, string>): void {
  for (const key of Object.keys(metadata)) {
    if (key.length === 0 || key.length > 79) {
      throw new RangeError(`PNG text chunk keyword must be 1-79 characters, got "${key}"`);
    }
    if (PNG_METADATA_FORBIDDEN_KEYS.test(key)) {
      throw new Error(
        `Refusing to write PNG metadata key "${key}": a score, grade or verdict must never travel ` +
          'inside a shared image. Named defects go in `dotloom:defects`; nothing else is a ' +
          'number. See AGENTS.md - the tool that published one was deleted in 0.3.1.',
      );
    }
    const value = metadata[key];
    if (typeof value !== 'string') {
      throw new TypeError(`PNG metadata "${key}" must be a string, got ${typeof value}`);
    }
    // Latin-1 by the PNG specification, checked by code point rather than by a regex:
    // a `\uXXXX` range in a source literal is one careless editor away from writing the
    // character it names, and this file has to stay text.
    for (const ch of value) {
      const code = ch.codePointAt(0) ?? 0;
      if (code > 0xff) {
        throw new Error(
          `PNG metadata "${key}" is not Latin-1, and a tEXt chunk cannot carry it. ` +
            'Drop the value, or move it into meta.json, which is UTF-8.',
        );
      }
      // Control characters are legal in a byte string and never in a declaration a person
      // reads. Tab is the one that survives: it is not a control character to a text editor.
      if ((code < 0x20 && ch !== '\t') || code === 0x7f) {
        throw new Error(`PNG metadata "${key}" holds a control character; a chunk is for prose.`);
      }
    }
    // **Narrow on purpose, unlike the key check.** A bare number in a chunk is the thing that
    // becomes a target; an asset legitimately named `quality-hero` is not a verdict, and
    // matching the whole vocabulary against values would refuse that name. A guard that cries
    // wolf on a sprite is a guard people turn off.
    //
    // `dotloom:schema` is the one exemption and it is not a concession: it is the contract
    // revision integer, which S3 says is the only version a reader needs, and it is a spec
    // revision rather than a measurement of anything.
    if (key !== 'dotloom:schema' && /^[+-]?\d+(\.\d+)?\s*%?$/.test(value.trim())) {
      throw new Error(
        `Refusing to write "${key}": a bare number inside a shared image becomes the target ` +
          'instead of the artwork. Named defects go in `dotloom:defects`. See AGENTS.md.',
      );
    }
  }
}

export function encodePNG(buffer: PixelBuffer, opts: PngEncodeOptions = {}): Uint8Array {
  const metadata = opts.metadata;
  if (metadata) assertPngMetadata(metadata);
  const text = metadata
    ? Object.fromEntries(Object.keys(metadata).sort().map((key) => [key, metadata[key]]))
    : undefined;
  const image = {
    width: buffer.width,
    height: buffer.height,
    data: buffer.data,
    channels: 4,
    depth: 8 as const,
    ...(text ? { text } : {}),
  };
  return opts.level === undefined
    ? encodePng(image)
    : encodePng(image, { zlib: { level: opts.level as never } });
}

/**
 * Read a PNG's `tEXt` chunks back.
 *
 * The mirror of `encodePNG({metadata})`, and the reason the metadata is testable at all: a badge
 * nobody can read back is a badge nobody can check, and a chunk that cannot be decoded is a claim
 * that cannot be verified by whoever receives the file.
 */
export function readPNGMetadata(bytes: Uint8Array): Record<string, string> {
  const decoded = decodePng(bytes);
  return { ...(decoded.text ?? {}) };
}

export function decodePNG(bytes: Uint8Array): PixelBuffer {
  return pixelBufferFromDecodedPng(decodePng(bytes));
}

export function pixelBufferFromDecodedPng(decoded: DecodedPng): PixelBuffer {
  const { width, height } = decoded;
  const out = new PixelBuffer(width, height);
  const dst = out.data;

  // Indexed images: fast-png hands back packed indices plus a palette.
  if (decoded.palette && decoded.palette.length > 0) {
    const entryLength = decoded.palette[0].length; // 3 = RGB, 4 = RGBA (tRNS present)
    const rgb = convertIndexedToRgb(decoded);
    const hasAlpha = entryLength >= 4;
    for (let i = 0, p = 0, s = 0; i < width * height; i++, p += 4, s += entryLength) {
      dst[p] = rgb[s];
      dst[p + 1] = rgb[s + 1];
      dst[p + 2] = rgb[s + 2];
      dst[p + 3] = hasAlpha ? rgb[s + 3] : 255;
    }
    return out;
  }

  const channels = decoded.channels;
  const depth = decoded.depth;
  const src = decoded.data as unknown as ArrayLike<number>;

  // Sub-byte greyscale (1, 2 or 4 bpp): data is still bit-packed.
  if (depth < 8) {
    const rowBytes = Math.ceil((width * depth) / 8);
    const maxValue = (1 << depth) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bitIndex = x * depth;
        const byte = src[y * rowBytes + (bitIndex >> 3)] ?? 0;
        const shift = 8 - depth - (bitIndex & 7);
        const value = (byte >> shift) & maxValue;
        const grey = Math.round((value * 255) / maxValue);
        const p = out.index(x, y);
        dst[p] = grey;
        dst[p + 1] = grey;
        dst[p + 2] = grey;
        dst[p + 3] = 255;
      }
    }
    return out;
  }

  const max = depth === 16 ? 65535 : 255;
  const scale = 255 / max;

  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    let r: number;
    let g: number;
    let b: number;
    let a: number;
    switch (channels) {
      case 1:
        r = g = b = src[i] * scale;
        a = 255;
        break;
      case 2:
        r = g = b = src[i * 2] * scale;
        a = src[i * 2 + 1] * scale;
        break;
      case 3:
        r = src[i * 3] * scale;
        g = src[i * 3 + 1] * scale;
        b = src[i * 3 + 2] * scale;
        a = 255;
        break;
      default:
        r = src[i * 4] * scale;
        g = src[i * 4 + 1] * scale;
        b = src[i * 4 + 2] * scale;
        a = src[i * 4 + 3] * scale;
        break;
    }
    dst[p] = r;
    dst[p + 1] = g;
    dst[p + 2] = b;
    dst[p + 3] = a;
  }
  return out;
}

/** PNG signature check, so callers can give a decent error for non-PNG input. */
export function isPNG(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}
