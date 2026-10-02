/**
 * The digest behind `meta.json`'s identity field, and the byte framing it hashes.
 *
 * ## Why there is a hash here at all
 *
 * The document model gives every sprite, layer, frame and tag an id, and those ids are
 * clock-plus-entropy on purpose (`ids.ts`). That is the right choice for a live editor and
 * the wrong one for an *asset identity*: two people who draw the same four-frame sprite
 * must get the same identity, on two machines, in two sessions, or every importer cache
 * in every engine misses on first contact. So the identity is a digest of the asset, and
 * the document ids are deliberately excluded from it — see S4 of `docs/ASSET-CONTRACT.md`
 * for the full list of what is and is not inside.
 *
 * ## Why SHA-256, implemented here, is not over-engineering
 *
 * No importer recomputes this digest — none of them can, since recomputing it means
 * re-compositing every frame and rebuilding this exact preimage. It is a **cache key and a
 * change detector**, not a trust boundary, so a 32-bit hash would technically do the job.
 * It is not used anyway: a 32-bit value collides by birthday bound somewhere around 65k
 * assets, which for a studio is not a security problem but *is* a routine bug — two sprites
 * in one project silently sharing an identity. And `finalize_document` already publishes
 * SHA-256 of every exported byte, so one hash vocabulary across the bundle beats two.
 *
 * `packages/core` has four runtime dependencies and none of them is a crypto library, so
 * this is the FIPS 180-4 algorithm written out. It is the one piece of this directory that
 * is deliberately not novel code; `test/asset-contract.test.ts` pins it against the
 * published NIST vectors, which is the only honest way to ship a hand-written SHA-256.
 */

/** Round constants, FIPS 180-4 §4.2.2. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash value, FIPS 180-4 §5.3.3. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * Raw pixel or byte data.
 *
 * `PixelBuffer.data` is a `Uint8ClampedArray` and this module's own scratch buffers are
 * `Uint8Array`. They are different types with the same layout and the same contents, and
 * widening to the union here is cheaper than a conversion that would copy every composited
 * frame.
 */
export type RawBytes = Uint8Array | Uint8ClampedArray;

/** Rotate right within a 32-bit word. */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Streaming SHA-256.
 *
 * Streaming rather than "concatenate then hash" because the largest preimage this
 * repository can produce is a 512×512 sheet over forty frames — 42 MB of RGBA — and a
 * non-streaming version would need all of it resident twice, at the one moment in an
 * export when memory is already holding the sheet.
 *
 * {@link hex} finalises the state: it pads, compresses the tail, and is **not** safe to
 * call twice. One digest per writer is the only use in this directory, so the alternative
 * is a copy of eight words per call for no caller that wants one.
 */
export class Sha256 {
  private readonly state = new Uint32Array(H0);
  private readonly words = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private totalLength = 0;

  /** Feed bytes in. Order matters; any number of calls is fine. */
  update(bytes: RawBytes): this {
    this.totalLength += bytes.length;
    let offset = 0;
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, bytes.length);
      this.block.set(bytes.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength === 64) {
        this.compress(this.block, 0);
        this.blockLength = 0;
      }
    }
    // Whole blocks are hashed straight out of the caller's array: a 42 MB preimage never
    // gets copied.
    for (; offset + 64 <= bytes.length; offset += 64) this.compress(bytes, offset);
    if (offset < bytes.length) {
      this.block.set(bytes.subarray(offset), 0);
      this.blockLength = bytes.length - offset;
    }
    return this;
  }

  /** Lowercase hex, 64 characters. Finalises; call once. */
  hex(): string {
    const bitLength = this.totalLength * 8;
    // 0x80, then zero padding, then the 64-bit big-endian bit count. A block that already
    // holds 56..63 bytes needs a whole extra block for the length.
    const tail = new Uint8Array(this.blockLength < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.blockLength));
    tail[this.blockLength] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(tail.length - 4, bitLength >>> 0);
    for (let offset = 0; offset < tail.length; offset += 64) this.compress(tail, offset);

    let out = '';
    for (let i = 0; i < 8; i++) out += this.state[i].toString(16).padStart(8, '0');
    return out;
  }

  private compress(source: RawBytes, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = ((source[p] << 24) | (source[p + 1] << 16) | (source[p + 2] << 8) | source[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ (rotr(e, 25))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ (rotr(a, 22))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

/** The digest of a byte string, lowercase hex. Convenience over {@link Sha256}. */
export function sha256Hex(bytes: RawBytes): string {
  return new Sha256().update(bytes).hex();
}

/**
 * UTF-8 encode, with lone surrogates replaced by U+FFFD.
 *
 * Hand-written rather than `TextEncoder` for two reasons. `packages/core` compiles against
 * `lib: ["ES2022"]` with no DOM and no ambient Node types, so `TextEncoder` is not a name
 * this package can see; and the substitution rule has to be *stated*, because a tag name
 * typed with a broken surrogate is hashed here and re-hashed by whoever verifies the
 * digest in another language, and U+FFFD is the substitution every mainstream encoder
 * already performs.
 */
export function utf8Bytes(value: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(out);
}

/**
 * Writes the canonical digest preimage: little-endian integers, and every variable-length
 * field **length-prefixed**.
 *
 * The prefixes are not decoration. Without them, a tag named `ab` next to a tag named `c`
 * hashes exactly like a tag named `a` next to one named `bc`, and the digest silently
 * stops being a function of the asset. Length prefixes cost four bytes each and make the
 * framing injective.
 *
 * The layout is published in S4.3 of `docs/ASSET-CONTRACT.md` because it is a wire format:
 * the digest's value is that two independent implementations agree on it, and that is
 * only true if the bytes are written down rather than implied by this class.
 */
export class AssetDigestWriter {
  private readonly hash = new Sha256();
  private readonly scratch = new Uint8Array(4);

  /** The document-type marker, so a digest can never be mistaken for another hash. */
  magic(marker: string, version: number): this {
    return this.ascii(marker).u8(version);
  }

  /** One unsigned byte. */
  u8(value: number): this {
    this.scratch[0] = value & 0xff;
    this.hash.update(this.scratch.subarray(0, 1));
    return this;
  }

  /** One unsigned 32-bit little-endian word. */
  u32(value: number): this {
    this.scratch[0] = value & 0xff;
    this.scratch[1] = (value >>> 8) & 0xff;
    this.scratch[2] = (value >>> 16) & 0xff;
    this.scratch[3] = (value >>> 24) & 0xff;
    this.hash.update(this.scratch);
    return this;
  }

  /** A length-prefixed UTF-8 string. */
  ascii(value: string): this {
    const bytes = utf8Bytes(value);
    this.u32(bytes.length);
    this.hash.update(bytes);
    return this;
  }

  /** A length-prefixed byte run. */
  blob(value: RawBytes): this {
    this.u32(value.length);
    this.hash.update(value);
    return this;
  }

  /** `sha256:<hex>`, the on-wire form of {@link Sha256.hex}. */
  hex(): string {
    return `sha256:${this.hash.hex()}`;
  }
}