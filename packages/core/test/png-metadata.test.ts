import { describe, expect, it } from 'vitest';
import { PixelBuffer } from '../src/buffer.js';
import {
  PNG_METADATA_FORBIDDEN_KEYS,
  PNG_PROVENANCE_KEYS,
  assertPngMetadata,
  decodePNG,
  encodePNG,
  readPNGMetadata,
} from '../src/png.js';

/**
 * PNG provenance: what a shared file says about itself, and what it is forbidden to say.
 *
 * Four claims, each one measured rather than asserted in prose:
 *
 *   1. **A text chunk round-trips.** Write it, decode the bytes back, read the chunk. A badge
 *      nobody can read back is a badge nobody can check, and the recipient of a shared file is the
 *      only person who matters here - they have no repository and no `evaluate`.
 *
 *   2. **The pixels are untouched.** This is the claim that makes "the badge is not burned in"
 *      true rather than a comment: the decoded RGBA before and after adding metadata is
 *      byte-identical, so the artwork under the badge is recoverable by anyone who decodes the
 *      file.
 *
 *   3. **A verdict cannot be written.** The refusal is on the *writer*, not in a test that runs
 *      after the fact, because the one thing this repository deleted in 0.3.1 was a tool that
 *      published a number and watched a model sand a lake into a dark flat rectangle to keep it
 *      clean. A text chunk travels - it is pasted, mailed and re-saved by people who never open
 *      it - which makes it the last place a number should be allowed to hide.
 *
 *   4. **The encoder is deterministic.** Same input, same bytes: the chunk order is sorted rather
 *      than insertion-ordered, so a `Record` built two different ways cannot produce two files.
 */

/** A small, non-uniform buffer, so a pixel-level comparison is not comparing two flat fills. */
function sample(): PixelBuffer {
  const buf = new PixelBuffer(8, 4);
  for (let i = 0; i < buf.data.length; i += 4) {
    buf.data[i] = (i * 7) % 256;
    buf.data[i + 1] = (i * 13) % 256;
    buf.data[i + 2] = (i * 29) % 256;
    buf.data[i + 3] = i % 96 === 0 ? 0 : 255;
  }
  return buf;
}

const PROVENANCE = {
  Software: 'dotloom-mcp',
  'dotloom:asset': `sha256:${'a'.repeat(64)}`,
  'dotloom:name': 'lantern-keeper',
  'dotloom:contract': 'dotloom-mcp/asset-meta',
  'dotloom:schema': '1',
  'dotloom:defects': 'outline-gap,thin-profile',
};

describe('PNG metadata round-trips', () => {
  it('reads back every chunk it wrote', () => {
    const bytes = encodePNG(sample(), { metadata: PROVENANCE });
    expect(readPNGMetadata(bytes)).toEqual(PROVENANCE);
  });

  it('round-trips through a decode/re-encode cycle, which is what a recipient does', () => {
    const once = encodePNG(sample(), { metadata: PROVENANCE });
    const twice = encodePNG(decodePNG(once), { metadata: readPNGMetadata(once) });
    expect(readPNGMetadata(twice)).toEqual(PROVENANCE);
  });

  it('carries no chunk at all when given none, rather than an empty one', () => {
    // An image with zero tEXt chunks and an image with one empty chunk are different files, and
    // only the first is what every PNG in this repository was before this change.
    expect(readPNGMetadata(encodePNG(sample()))).toEqual({});
  });

  it('produces the same bytes for the same metadata however the object was built', () => {
    // Determinism, on the axis that could actually differ: two `Record`s with identical entries in
    // a different insertion order. Without the sort this is a diff on every caller's refactor.
    const shuffled = Object.fromEntries(Object.entries(PROVENANCE).reverse());
    expect(encodePNG(sample(), { metadata: shuffled })).toEqual(
      encodePNG(sample(), { metadata: PROVENANCE }),
    );
  });
});

describe('the badge is metadata, not pixels', () => {
  it('changes no pixel, so the artwork underneath is recoverable', () => {
    // **This is the assertion that decides the design.** A burned badge cannot be recovered by
    // anyone who did not watch it happen, and it changes what every downstream engine resamples.
    // Both generations decode to the same RGBA; only the second carries a `Software` chunk.
    const plain = encodePNG(sample());
    const badged = encodePNG(sample(), { metadata: PROVENANCE });
    expect([...decodePNG(badged).data]).toEqual([...decodePNG(plain).data]);
    expect(decodePNG(badged).width).toBe(decodePNG(plain).width);
    expect(decodePNG(badged).height).toBe(decodePNG(plain).height);
    // And the two files really are different files, so this is not passing because nothing happened.
    expect(Buffer.from(badged)).not.toEqual(Buffer.from(plain));
    expect(readPNGMetadata(plain)).toEqual({});
  });

  it('does not change what a re-encode of the decoded image looks like either', () => {
    // The stronger form, and the one a recipient actually hits: strip the chunks by decoding, and
    // the artwork is still exactly the artwork. Nothing to un-burn, because nothing was burned.
    const badged = encodePNG(sample(), { metadata: PROVENANCE });
    const recovered = encodePNG(decodePNG(badged));
    expect([...decodePNG(recovered).data]).toEqual([...sample().data]);
  });
});

describe('a verdict cannot be written into a PNG', () => {
  it('names every keyword that could carry one', () => {
    // These are the shapes that came back from `evaluate`: the deleted tool's own field names.
    for (const key of ['score', 'scoreQ', 'quality', 'grade', 'rating', 'verdict', 'percent']) {
      expect(PNG_METADATA_FORBIDDEN_KEYS.test(key), `${key} should be refused`).toBe(true);
    }
  });

  it('refuses a score-shaped key, with a message that says where to put it instead', () => {
    expect(() => encodePNG(sample(), { metadata: { score: '912' } })).toThrow(/dotloom:defects/);
    expect(() => assertPngMetadata({ verdict: 'pass' })).toThrow(/verdict/i);
  });

  it('refuses a bare number under any key but the contract revision', () => {
    // A number is the thing that becomes a target. The one exemption is not a concession:
    // `dotloom:schema` is a spec revision integer, which S3 says is the only version a reader
    // needs, and it measures nothing.
    // Built with `String.fromCharCode` rather than a `\uXXXX` literal: an escape sequence in a
    // source literal is one tool away from being the character it names, and a test that cannot
    // be parsed is a test that asserts nothing.
    const nihon = String.fromCharCode(0x4f60, 0x597d);
    const emoji = String.fromCodePoint(0x1f3a8);
    expect(() => assertPngMetadata({ 'dotloom:name': nihon })).toThrow(/Latin-1/);
    expect(() => assertPngMetadata({ 'dotloom:name': emoji })).toThrow(/Latin-1/);
  });

  it('accepts Latin-1, which is a real answer rather than a smaller one', () => {
    // 0xe9 is Latin-1, so this is a real answer rather than a smaller one.
    expect(() => assertPngMetadata({ 'dotloom:name': 'caf' + String.fromCharCode(0xe9) + '-keeper' })).not.toThrow();
    // And it round-trips as latin1 bytes, so what was written is what is read.
    const cafe = 'caf' + String.fromCharCode(0xe9) + '-keeper';
    const bytes = encodePNG(sample(), { metadata: { 'dotloom:name': cafe } });
    expect(readPNGMetadata(bytes)['dotloom:name']).toBe(cafe);
  });

  it('rejects a control character, which is legal in a byte string and never in a declaration', () => {
    expect(() => assertPngMetadata({ 'dotloom:defects': 'a\nb' })).toThrow(/control character/);
    expect(() => assertPngMetadata({ 'dotloom:name': 'a\tb' })).not.toThrow();
  });

  it('rejects a keyword outside the PNG spec\'s 1..79', () => {
    expect(() => assertPngMetadata({ '': 'x' })).toThrow(/1-79/);
    const long = 'k'.repeat(80);
    const atLimit = 'k'.repeat(79);
    expect(() => assertPngMetadata({ [long]: 'x' })).toThrow(/1-79/);
    // The near-miss on the other side: 79 is the spec's ceiling and it is allowed.
    expect(() => assertPngMetadata({ [atLimit]: 'x' })).not.toThrow();
  });
});
