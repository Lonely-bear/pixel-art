import { z } from 'zod';

/**
 * The `meta.json` contract: one asset description, four engines, one file.
 *
 * ## Why this file, and why zod
 *
 * This is the shape, declared once. The serialiser in `build.ts` builds it, the validator
 * in `validate.ts` checks it, and the field table in `docs/ASSET-CONTRACT.md` describes
 * it — and the last of those three is prose, which does not fail a build. So the spec and
 * this schema are bound together by `test/asset-contract.test.ts`, which *parses the
 * specification's field table* and fails when a field here has no row there or a row there
 * has no field here. That is the same drift guard `quality-weights.test.ts` puts on
 * `docs/EVALUATION.md`, and for the same reason: a duplicated literal only relocates drift,
 * it does not detect it.
 *
 * The field order below is not cosmetic. It is the order the bytes are written in, because
 * `orderBySchema` in `build.ts` walks `Object.keys(schema.shape)` — so the zod declaration
 * order *is* the serialisation order, there is no second list, and the two cannot drift.
 *
 * ## `.strict()` everywhere, and what that costs
 *
 * Every object is strict, matching `defineCommand`. That is what turns a misspelled field
 * into a report instead of a silently ignored one — and it is also what makes forward
 * compatibility expressible, because a strict object is the only way to *distinguish* "this
 * file carries a field I have never heard of" from "this file is fine". The compatibility
 * policy is then carried by severity rather than by leniency: an unknown key is an
 * `unknown-field` **advisory**, everything else is an error. A reader tolerates the future
 * and still refuses the typo, which is the whole point of asking for machine-readable
 * reasons rather than a boolean.
 *
 * Every field carries a `.describe()`, for the same reason command parameters do: this text
 * is what an agent or an integrator reads to decide how to use the contract, and it is what
 * {@link assetMetaJsonSchema} publishes as JSON Schema.
 */

/**
 * The document-type marker. Sniffed by T-055 and by any importer that is handed a directory
 * of files and has to work out which one is the contract.
 */
export const ASSET_META_FORMAT = 'dotloom-mcp/asset-meta';

/**
 * The contract revision this build writes, and the highest it understands.
 *
 * One integer, bumped only for a breaking change. Adding a field is **not** a version
 * bump: `docs/ASSET-CONTRACT.md` S3 pins that rule, and it is the single decision that
 * makes T-051…T-054 cheap, because a reader that has to be re-audited every time anyone
 * thinks of a new field is a reader nobody will ever write.
 */
export const ASSET_META_SCHEMA_VERSION = 1;

/** The same ceiling, named separately so the validator's message can quote the reason. */
export const MAX_SUPPORTED_ASSET_META_VERSION = ASSET_META_SCHEMA_VERSION;

/**
 * The revision of the **digest preimage**, which is independent of
 * {@link ASSET_META_SCHEMA_VERSION} on purpose.
 *
 * If it tracked the schema, a spec revision that changed nothing about the asset would
 * invalidate every cached digest for every asset in every project — the identity of a
 * sprite would move because a field was documented. It only moves when the *bytes that go
 * into the hash* change, which is the one thing a cache actually depends on.
 */
export const ASSET_DIGEST_VERSION = 1;

/**
 * What kind of asset this is.
 *
 * A single-member enum, and that is the point rather than an oversight: `tileset` and
 * `tilemap` are not modelled at schemaVersion 1, so a reader that meets one has been handed
 * a document it genuinely cannot serve and must say so. A closed enum makes that an error.
 * Widening this list is a **minor** change — the first value after `sprite` gets its own
 * specification section, and readers that do not recognise it keep working by refusing it.
 */
export const assetKindSchema = z.enum(['sprite']);

/** Playback order for an animation, matching `AnimationTag['direction']` in the document. */
export const assetDirectionSchema = z.enum(['forward', 'reverse', 'pingpong']);

/** What an entry in `outputs` is, so an importer can find the sheet without parsing names. */
export const assetOutputRoleSchema = z.enum([
  'source',
  'frame',
  'sheet-json',
  'gif',
  'contact-sheet',
  // Present in the enum, rejected by the validator. A dedicated `reserved-output-role`
  // diagnostic says *why*, and "expected one of these six" does not, so the member is
  // admitted to the shape and refused by the rule that knows the reason.
  'sheet',
]);

/**
 * Why a pivot has the value it has.
 *
 * `'default'` is the honest label for "nobody chose this, it is the documented fallback".
 * Emitting the fallback unconditionally, labelled, is better than omitting the field:
 * an importer never has to know the default, and a reader can still tell a chosen pivot
 * from a derived one. The alternative — omit the field when unspecified — makes an importer
 * guess, and a pivot guessed as the canvas centre on a character sprite is a sprite that
 * floats half a body above the floor.
 */
export const assetPivotSourceSchema = z.enum(['default', 'rig-part']);

/** Pixel dimensions. Integers, because a pixel is the unit this whole repository draws in. */
const sizeShape = {
  width: z.number().int().min(1).describe('Width in pixels. Counted in pixels, not cells.'),
  height: z.number().int().min(1).describe('Height in pixels. Counted in pixels, not cells.'),
};

const sizeSchema = z.object(sizeShape).strict();

export const assetMetaSchema = z
  .object({
    format: z
      .literal(ASSET_META_FORMAT)
      .describe(
        `Always "${ASSET_META_FORMAT}". Check this before anything else: it says the file is an asset contract at all, rather than an export manifest, an Aseprite sheet JSON or a level file that happens to sit in the same folder.`,
      ),

    schemaVersion: z
      .number()
      .int()
      .min(1)
      .describe(
        `Contract revision, currently ${ASSET_META_SCHEMA_VERSION}. Compare it against the reader's own ceiling before trusting any field. A newer number means a newer writer, not a corrupt file: keep reading the fields you know.`,
      ),

    kind: assetKindSchema.describe(
      'What this file describes. Only "sprite" exists at schemaVersion 1 — a tileset or tilemap contract is refused rather than half-written, so this value is never a guess.',
    ),

    asset: z
      .object({
        name: z
          .string()
          .min(1)
          .max(255)
          .describe(
            'The asset\'s own name: what a human calls it and what an importer registers it under. It is a lookup key, NOT the identity — renaming an asset must not invalidate its cache, so it is excluded from the content hash. Every target engine has a path-length limit somewhere near 255 bytes, which is where the maximum comes from.',
          ),
        contentHash: z
          .string()
          .describe(
            'Identity, as `sha256:` followed by 64 lowercase hex digits. Computed over the canvas size, every composited frame with its duration, the palette and the animation tags — see S4 of the contract. Two exports of the same asset agree on this; two documents that draw the same pixels with different ids do not disagree. Use it as a cache key and a "did the artwork change" check, never as an authenticity claim: nobody verifies it.',
          ),
      })
      .strict()
      .describe('Who this asset is: a name to look it up by, and a digest to cache it by.'),

    frames: z
      .object({
        count: z
          .number()
          .int()
          .min(1)
          .describe(
            'Number of frames on the timeline, and therefore the number of cells in a sheet. Equal to durationsMs.length; a mismatch means the file was hand-edited.',
          ),
        size: sizeSchema.describe(
          'The size of ONE frame, in canvas pixels. This is also the size of the source canvas: every frame in a document shares one canvas, so there is no per-frame crop to describe. Engines slice on this, not on the sheet size.',
        ),
        durationsMs: z
          .array(z.number().int().min(1))
          .describe(
            'How long each frame is held, in milliseconds, in timeline order (index 0 first). THIS is the field no engine can infer from a PNG and the reason this file exists. Positional rather than an array of objects so a four-frame sprite costs four numbers instead of four JSON objects.',
          ),
        totalMs: z
          .number()
          .int()
          .min(1)
          .describe(
            'Derived: sum of durationsMs, in milliseconds — one pass over the whole timeline. Precomputed so a player needs no loop to find the cycle length.',
          ),
        fps: z
          .number()
          .min(0)
          .describe(
            'Derived: mean frame rate over the whole timeline, `1000 * count / totalMs` rounded to three decimals. A CONVENIENCE for engines that take one number; `durationsMs` is authoritative, because a timeline of 100/100/200 ms has no single true fps and this is the least-bad one.',
          ),
      })
      .strict()
      .describe('The timeline: how many frames, how big each one is, and how long each one is held.'),

    animations: z
      .object({
        default: z
          .string()
          .min(1)
          .describe(
            'Name of the animation a player should play when nothing is asked for. Required inside `animations` because an engine that has to guess picks the first one, and "the first one" is not a decision anyone made.',
          ),
        items: z
          .array(
            z
              .object({
                name: z
                  .string()
                  .min(1)
                  .describe(
                    'The animation\'s name, as it appears in the document\'s tags. This is the string game code calls, and it is included in the content hash for exactly that reason — renaming an animation is a code-visible change.',
                  ),
                from: z
                  .number()
                  .int()
                  .min(0)
                  .describe('First frame of the range, inclusive, as a 0-based timeline index.'),
                to: z
                  .number()
                  .int()
                  .min(0)
                  .describe('Last frame of the range, inclusive, as a 0-based timeline index.'),
                direction: assetDirectionSchema.describe(
                  'Which way the range plays. Kept for engines that can express it natively; `frames` below is the authority because not all of them can.',
                ),
                repeat: z
                  .number()
                  .int()
                  .min(0)
                  .describe(
                    'How many times the animation plays. 0 means forever. Note this is a PASS COUNT and not a total frame count — `frames` holds one pass, and the engine repeats it.',
                  ),
                loop: z
                  .boolean()
                  .describe(
                    'Whether playback loops forever. Exactly equivalent to `repeat === 0`, and stated as its own boolean because "does this loop" is the first question every engine asks and deriving it from a sentinel is how an importer ends up looping a two-shot attack.',
                  ),
                frames: z
                  .array(z.number().int().min(0))
                  .describe(
                    'The frame indices to play, ALREADY EXPANDED, in order — one pass, repeats not included. A pingpong is written out as its real playback order so an importer never has to implement reverse or bounce, which is where naive importers get it wrong.',
                  ),
                durationMs: z
                  .number()
                  .int()
                  .min(1)
                  .describe('Derived: length of ONE pass in milliseconds. Multiply by `repeat` for a non-looping animation.'),
                fps: z
                  .number()
                  .min(0)
                  .describe('Derived: mean frame rate of this animation alone, same rounding as the timeline `fps`.'),
              })
              .strict(),
          )
          .min(1)
          .describe('Every animation in the document, in document order.'),
      })
      .strict()
      .optional()
      .describe(
        'Playback: which animations exist, which frames each one shows and in what order. Absent for a single-frame still, which is not a failure — a still has no animation and saying so is different from saying it has an empty one.',
      ),

    sheet: z
      .object({
        image: z
          .string()
          .min(1)
          .describe(
            'Path to the spritesheet PNG, relative to the folder holding this file, using forward slashes. Relative is a hard rule: this file has to survive being moved into a game project, and an absolute path from the artist\'s machine is the one thing that never survives that.',
          ),
        columns: z.number().int().min(1).describe(
          'Cells per row. With `regions`, fully determines the arrangement. `layout`, `padding` and `margin` are deliberately absent: the packing result does not carry them, and re-deriving them here would create a second geometry authority to keep in step with the first. Their absence is also why `regions` is authoritative rather than recomputable — see its own description.',
        ),
        rows: z.number().int().min(1).describe('Rows of cells.'),
        scale: z
          .number()
          .int()
          .min(1)
          .describe(
            'Derived: the integer upscale the sheet was written at, relative to `frames.size`. 1 for a 1:1 sheet. Present because a 2x sheet and a 32px sheet are the same artwork at different sampling rates, and an importer that filters an upscaled sheet correctly has to be told it was upscaled.',
          ),
        size: sizeSchema.describe(
          "The sheet image's own dimensions, in pixels. Authoritative rather than derived, because the transparent gap between cells and the border around the sheet are not recorded here and are exactly what a recomputation would need. Differs from `frames.size` whenever `scale` is above 1.",
        ),
        regions: z
          .array(
            z
              .object({
                index: z.number().int().min(0).describe('Derived: which timeline frame this cell holds; always equal to its own position in the array.'),
                x: z.number().int().min(0).describe('Left edge of the cell in the sheet, in sheet pixels.'),
                y: z.number().int().min(0).describe('Top edge of the cell in the sheet, in sheet pixels.'),
                width: z.number().int().min(1).describe('Derived: cell width; equals rames.size.width * sheet.scale.'),
                height: z.number().int().min(1).describe('Derived: cell height; equals rames.size.height * sheet.scale.'),
              })
              .strict(),
          )
          .describe(
            'One rectangle per frame, in timeline order. AUTHORITATIVE: read these, do not recompute them from `columns`, because the packer may have inserted a gap or a border that this contract does not record. What is verified is that every cell is `frames.size * scale`, sits inside the sheet, and appears in the row-major order `columns`/`rows` implies.',
          ),
      })
      .strict()
      .optional()
      .describe(
        'The packed spritesheet. Absent when the export wrote individual PNGs instead, which is a legitimate choice — this describes a sheet, and there is no sheet to describe.',
      ),

    pivot: z
      .object({
        x: z.number().describe('Pivot X in canvas pixels, measured from the left edge. May be fractional, and may sit on the right edge.'),
        y: z.number().describe('Pivot Y in canvas pixels, measured from the top edge. May be fractional, and may sit on the bottom edge.'),
        source: assetPivotSourceSchema.describe(
          'Whether anyone chose this pivot or it is the documented fallback. Godot wants an offset from the centre, Unity a pixel pivot, Phaser an origin — this stores the one value they all convert from.',
        ),
      })
      .strict()
      .describe(
        'The sprite\'s rotation/scaling origin. Always present, because every engine needs one and an importer that has to guess it gets a character sprite hovering half a body above the floor.',
      ),

    palette: z
      .object({
        name: z.string().min(1).describe('Palette name, for a tool that shows swatches.'),
        locked: z
          .boolean()
          .describe(
            'Whether the artwork is snapped to this palette. Advisory: it describes how the art was made, is not covered by the content hash, and is a hint to an importer about recolouring, not a constraint it must enforce.',
          ),
        colors: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            'Swatches in palette-index order — the order the artwork addresses them in. `#rrggbb`, or `#rrggbbaa` when the swatch is not fully opaque. Index order is the contract; sorted order would be a different asset.',
          ),
        roles: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Semantic role by DECIMAL PALETTE INDEX, e.g. `{"3": "skin"}`. Present only when the document has roles. Sorted numerically on write so the file diffs cleanly.',
          ),
      })
      .strict()
      .optional()
      .describe(
        'The palette the artwork was drawn against. Not derivable from the PNG — the pixels carry the colours but not their indices, their order, or their names, and an importer cannot rebuild a ramp from a flat list of swatches. Absent means "this asset carries no palette constraint", which is a real state for full-RGB art; it never means "16 colours".',
      ),

    license: z
      .object({
        spdx: z
          .string()
          .min(1)
          .describe(
            'SPDX licence identifier, e.g. `CC0-1.0` or `MIT`. Required when `license` is present because a licence that cannot be branched on by machine is a comment, not a licence.',
          ),
        name: z.string().min(1).optional().describe('Human-readable licence name, when it differs from the SPDX id.'),
        url: z.string().min(1).optional().describe('Where the full licence text lives, if not the SPDX id\'s canonical page.'),
        attribution: z.string().min(1).optional().describe('Credit line the game must display, when the licence requires one.'),
      })
      .strict()
      .optional()
      .describe(
        'Licensing. Optional and NEVER invented: absent means "not specified", which is not the same as "public domain" and must not be treated as permission. The document model has no licence field, so this is the one part of the contract the caller supplies.',
      ),

    outputs: z
      .array(
        z
          .object({
            role: assetOutputRoleSchema.describe(
              'What this file is. `source` is the editable document; the rest are derived. "sheet" is reserved and rejected with `reserved-output-role` - the sheet path is `sheet.image`, and having both is one path with two chances to disagree.',
            ),
            path: z
              .string()
              .min(1)
              .describe('Path relative to the folder holding this file, using forward slashes.'),
          })
          .strict(),
      )
      .optional()
      .describe(
        'The rest of the bundle: what was written next to the sheet, and what each file is for. Absent when the bundle is a sheet and nothing else.',
      ),
  })
  .strict();

/**
 * The contract, as a TypeScript type derived from the schema.
 *
 * Derived rather than hand-written on purpose. `quality/types.ts` argues the same point
 * for the quality report: an interface beside a schema is a second list, and a second list
 * is where "the code says 15%, the spec says 12%" comes from.
 */
export type AssetMeta = z.infer<typeof assetMetaSchema>;

/** Per-object TypeScript aliases, so an importer can type one node of the contract. */
export type AssetMetaFrames = AssetMeta['frames'];
export type AssetMetaAnimation = NonNullable<AssetMeta['animations']>['items'][number];
export type AssetMetaSheet = NonNullable<AssetMeta['sheet']>;
export type AssetMetaRegion = AssetMetaSheet['regions'][number];
export type AssetMetaPalette = NonNullable<AssetMeta['palette']>;
export type AssetMetaLicense = NonNullable<AssetMeta['license']>;
export type AssetMetaOutput = NonNullable<AssetMeta['outputs']>[number];

/**
 * JSON Schema for the contract, as a plain object.
 *
 * Published for WRITER validation — a tool that wants to check a `meta.json` before
 * accepting it. Readers must not use `additionalProperties: false` (which `.strict()`
 * produces) as a rejection rule; S3 of the contract is explicit that unknown fields are
 * advisory, and a JSON Schema validator is the most likely place for that rule to be
 * quietly ignored.
 */
export function assetMetaJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(assetMetaSchema, { io: 'output' }) as Record<string, unknown>;
}

/**
 * The schema underneath an optional / nullable / defaulted field.
 *
 * **Only those three.** zod 4 puts an `unwrap()` on `ZodArray` too, where it returns the
 * *element* schema, so a duck-typed `typeof schema.unwrap === 'function'` turns every array
 * into its element type. That is silent and wrong in both directions: the field walk loses
 * the array, and the serialiser stops descending into arrays, at which point the key order
 * inside array items comes from whatever built them rather than from the declaration. The
 * three classes that really do wrap are named instead.
 */
export function unwrapSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    // `unwrap()` is typed on zod's `_ZodType` interface and returns that interface, which is
    // not the `ZodType` class the `instanceof` checks need. The object it returns is the same
    // one either way.
    return (schema as unknown as { unwrap: () => z.ZodType }).unwrap();
  }
  return schema;
}

/** One row of the field reference, as the schema sees it. */
export interface AssetMetaField {
  /** Dotted path. An array's element object is written with a `[]` suffix. */
  readonly path: string;
  /** False when the field is `optional()` and may be absent entirely. */
  readonly required: boolean;
}

/**
 * Every field in the contract, in declaration order, with its requiredness.
 *
 * Derived from the schema rather than written out, because the field table in
 * `docs/ASSET-CONTRACT.md` S5 is a hand-maintained list and this is what the drift guard
 * compares it against. A hand-written list here would be a second list, which is the thing
 * the guard exists to prevent.
 */
export function assetMetaFieldPaths(schema: z.ZodType = assetMetaSchema): AssetMetaField[] {
  const out: AssetMetaField[] = [];
  const walk = (node: z.ZodType, prefix: string): void => {
    const required = !node.isOptional();
    const inner = unwrapSchema(node);
    if (inner instanceof z.ZodArray) {
      if (prefix) out.push({ path: prefix, required });
      // Only descend into an array whose elements are themselves structured. `number[]`
      // has no fields, and listing `frames.durationsMs[]` would be a row in the
      // specification that names something nobody can assign.
      const element = unwrapSchema(inner.element as z.ZodType);
      if (element instanceof z.ZodObject || element instanceof z.ZodArray) {
        walk(inner.element as z.ZodType, prefix ? `${prefix}[]` : '');
      }
      return;
    }
    if (prefix) out.push({ path: prefix, required });
    if (inner instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(inner.shape)) {
        walk(child as z.ZodType, prefix ? `${prefix}.${key}` : key);
      }
    }
  };
  walk(schema, '');
  return out;
}