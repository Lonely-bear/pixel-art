/**
 * The asset contract: `meta.json` as one engine-agnostic description of one asset.
 *
 * Four files, and the split is the point:
 *
 *   schema.ts   the shape. One declaration, and it is also the serialisation order, because
 *               `build.ts` walks `Object.keys(schema.shape)` to write the bytes.
 *   build.ts    the generator. Document in, contract bytes out, byte-identical every time.
 *   validate.ts the reader. Machine-readable reasons, so T-051…T-055 branch on a code
 *               rather than on prose.
 *   hash.ts     the digest. Pure-TS SHA-256 and the length-prefixed preimage, because the
 *               document's own ids are clock-plus-entropy and cannot be an identity.
 *
 * Not wired into `finalize_document` yet. That is deliberate and belongs to a later task:
 * the export path is shared, and the first question whoever takes it has to answer is
 * whether `meta.json` is written next to every export or is one more output the caller
 * opts into. Answering it here would have put a decision in the contract.
 *
 * No `format`, no `.pixel` extension and no second source of truth. Every field is either a
 * projection of the document model or a caller-supplied option the document model has no
 * field for — `license` is currently the only one of the latter, and it is never invented.
 */

export * from './hash.js';
export * from './schema.js';
export * from './build.js';
export * from './validate.js';
// The four engine importers and the naming validator, all consuming that one contract.
// `export *` rather than named re-exports: two one-token names in a package-wide barrel
// (`num`, `quote`) are a collision waiting to happen, and these were renamed for that reason.
export * from './importers/index.js';