/**
 * Stable ID generation.
 *
 * IDs are opaque strings and are **never reused**, so a stale reference from an AI agent
 * fails loudly instead of silently editing the wrong layer.
 *
 * `setIdFactory` lets tests swap in a deterministic generator.
 */

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
  const time = Date.now().toString(36);
  const seq = counter.toString(36).padStart(4, '0');
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0');
  return `${prefix}_${time}${seq}${rand}`;
}

/** A deterministic factory, handy for tests and golden-image fixtures. */
export function sequentialIdFactory(): (prefix: string) => string {
  let n = 0;
  return (prefix: string) => `${prefix}_${(++n).toString().padStart(4, '0')}`;
}
