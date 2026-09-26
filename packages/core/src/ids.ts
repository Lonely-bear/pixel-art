/**
 * Stable ID generation.
 *
 * IDs are opaque strings and are **never reused**, so a stale reference from an AI agent
 * fails loudly instead of silently editing the wrong layer.
 *
 * There are two ways to get an id, and which one you want depends on whether you are
 * editing a live document or regenerating one.
 *
 * ## The default: unique, and deliberately not reproducible
 *
 * {@link makeId} combines the clock with real entropy. That is correct for an editor:
 * two documents open in the same process must not hand out the same layer id, and an id
 * that sorts roughly by creation time makes a layer list readable. It follows that the
 * default is **not** reproducible, and the consequence is worth stating plainly —
 * replaying the same ops against a fresh document produces the same pixels but *not*
 * the same `.pixel` bytes, because `serializeSprite` puts the layer id into every cel
 * filename. If you need byte-identical output, you need {@link deterministicIdFactory}.
 *
 * ## The reproducible path
 *
 * {@link deterministicIdFactory} is the supported way to get byte-identical output from
 * the same ops. Install it with {@link setIdFactory} *before* constructing the document
 * and keep it installed for the whole build.
 *
 * It is opt-in rather than default because the two requirements genuinely conflict: a
 * counter-derived id is reproducible and trivially collides across two documents in one
 * process, and a clock-derived id does the opposite. Neither is a bug; they are answers
 * to different questions. The seed is what lets a caller have both — the seed makes
 * separate builds agree, and the prefix-plus-seed-plus-counter combination keeps
 * unrelated ids apart.
 *
 * The one rule: give two documents in the same process *different* seeds. Same seed plus
 * same ops means the same document, on purpose, and that is the feature — but it does
 * mean the ids collide, so a second copy is only safe when it is a second copy.
 */

import { mix32 } from './rng.js';

let counter = 0;
let factory: ((prefix: string) => string) | null = null;

/** Replace the ID generator (pass `null` to restore the default). */
export function setIdFactory(next: ((prefix: string) => string) | null): void {
  factory = next;
  counter = 0;
}

export function makeId(prefix: string): string {
  if (factory) return factory(prefix);
  counter = (counter + 1) >>> 0;
  // The only `Date.now()` and `Math.random()` left in the engine, and they stay. This is
  // the identity of a live document, not a value in a result: an id has to be unique
  // across processes and across documents, and the engine has no other entropy source
  // that works in the renderer, in a worker and in a bare test runner at once. Nothing
  // about a *drawing* result depends on it, which is why `rng.ts` can promise that no
  // field, scatter, terrain or reflection is ever non-reproducible. Callers who need
  // reproducible ids install `deterministicIdFactory` and this path never runs.
  const time = Date.now().toString(36);
  const seq = counter.toString(36).padStart(4, '0');
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0');
  return `${prefix}_${time}${seq}${rand}`;
}

/**
 * A deterministic factory, handy for tests and golden-image fixtures.
 *
 * Ids are a bare per-factory counter, so two factories produce the same sequence. Use
 * {@link deterministicIdFactory} instead whenever two documents live at once.
 */
export function sequentialIdFactory(): (prefix: string) => string {
  let n = 0;
  return (prefix: string) => `${prefix}_${(++n).toString().padStart(4, '0')}`;
}

/**
 * A reproducible id factory keyed on `seed`.
 *
 * Every id mixes the prefix, the seed and a per-prefix counter, so:
 *
 *   - the same seed and the same sequence of calls give byte-identical output, which is
 *     what makes replaying an ops list into a fresh document reproduce its baselines;
 *   - ids of different kinds (`lay` vs `frm` vs `tag`) never collide even though they
 *     share a counter, because the prefix is mixed in rather than concatenated;
 *   - a counter is kept *per prefix*, so deleting a layer does not renumber the frames
 *     created after it — an id stays attached to the thing it named.
 *
 * Not cryptographic, and it is not trying to be: these ids are addressing, not secrets.
 */
export function deterministicIdFactory(seed = 0): (prefix: string) => string {
  const counters = new Map<string, number>();
  // FNV-1a over the whole prefix, so the id namespaces are separated by content rather
  // than by string concatenation — `lay_1` and `lay` + `_1` can never collide, and an
  // empty prefix is still well defined.
  const prefixHashes = new Map<string, number>();
  return (prefix: string): string => {
    let ph = prefixHashes.get(prefix);
    if (ph === undefined) {
      ph = 0x811c9dc5;
      for (let i = 0; i < prefix.length; i++) {
        ph = Math.imul(ph ^ prefix.charCodeAt(i), 0x01000193);
      }
      prefixHashes.set(prefix, ph >>> 0);
    }
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    // One 32-bit word of mix over prefix, seed and counter. Wide enough that a seed
    // change moves every id; short enough that a manifest stays readable and diffs
    // line-by-line in git, which matters because these strings end up in filenames.
    const h = mix32(mix32(seed ^ ph) + Math.imul(n, 0x9e3779b9));
    return `${prefix}_${h.toString(36).padStart(7, '0')}`;
  };
}
