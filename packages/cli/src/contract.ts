/**
 * `pixel contract` — the asset contract and one engine's files, from the CLI.
 *
 * This is the third surface for `packages/core/src/asset/`. The MCP surface reaches it as two
 * opt-in output types inside one `finalize_document` plan, `{type: "meta", path}` and
 * `{type: "engine", engine, path}`, and every decision below is taken to match that plan rather
 * than to be the CLI's own opinion:
 *
 * - **Opt-in, never automatic.** A contract and a Godot resource are written only because they
 *   were asked for by name. `pixel export` and `pixel sheet` are byte-identical to what they
 *   were before this file existed.
 * - **Naming runs before anything is written, and an error refuses the write.** Same reason as
 *   the MCP gate: a reserved device name or a case-folded collision produces files that pass on
 *   the artist's machine and fail in CI, minutes from the cause and naming nothing. A naming
 *   *warning* never refuses — it is a project convention, and a validator that blocks a build
 *   over style is a validator a project switches off.
 * - **Warnings travel with the delivery.** Importer lossiness is reported in the result rather
 *   than left for a human to discover from a stutter.
 *
 * ## One command, not two
 *
 * `meta` is not a useful thing to want on its own for an engine target, and `--engine` is a
 * strict superset of the no-flag run, so one command with one flag is both smaller and impossible
 * to get wrong. It mirrors the MCP plan shape — one call, the engine is an option on it.
 *
 * ## No quality gate
 *
 * `AGENTS.md` records what a gate nobody has calibrated does to artwork, and the gate belongs to
 * the delivery path rather than to a flag that also has to describe six other things. A caller
 * that wants one can read the quality report through the library.
 *
 * Determinism is inherited rather than re-established: `buildAssetMeta` and the four importers
 * take no clock, no random source and no locale, so the same document writes the same bytes on
 * every machine. Nothing in this file adds a timestamp, a seed or a path outside the bundle.
 */

import { dirname, join, relative, resolve } from 'node:path';
import {
  buildAssetMeta,
  buildSpritesheet,
  encodePNG,
  importExcalidraw,
  importGodot,
  importPhaser,
  importUnity,
  scaleAtlas,
  serializeAssetMeta,
  validateAssetNaming,
  type AssetImportResult,
  type AssetMeta,
  type AssetMetaOutput,
  type AtlasOptions,
  type Sprite,
} from '@pixel/core';
import { intFlag, repeatFlag, stringFlag, UsageError, type ParsedArgs } from './args.js';
import { loadSprite, writeBytes, writeText } from './io.js';
import type { CommandContext, CommandSpec } from './commands.js';

/** The four importers, by the name the MCP surface and the docs both use. */
const ENGINE_IMPORTERS: Record<string, (input: unknown) => AssetImportResult> = {
  godot: importGodot,
  unity: importUnity,
  phaser: importPhaser,
  excalidraw: importExcalidraw,
};

/**
 * `outputs[].role`, as a closed set.
 *
 * `sheet` is reserved by the contract (S5): the sheet path is `sheet.image`, and listing it
 * twice gives one path two chances to disagree. Rejected here as a usage error rather than left
 * to the contract validator, so the message names the flag instead of arriving as an
 * `invalid-value` from three layers down.
 */
const OUTPUT_ROLES = ['source', 'frame', 'sheet-json', 'gif', 'contact-sheet'] as const;

/** A path relative to the folder holding `meta.json`, forward slashes on every platform. */
function bundleRelative(metaPath: string, target: string): string {
  return relative(dirname(resolve(metaPath)), resolve(target)).split('\\').join('/');
}

/** The failure envelope, on stderr, shaped like `index.ts`'s `fail()` plus the gate's findings. */
function fail(message: string, extra: Record<string, unknown>, code = 1): number {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message, ...extra }, null, 2)}\n`);
  return code;
}

/**
 * `<role>:<path>`, repeatable. The MCP surface takes the same pair as an array of objects.
 *
 * `repeatFlag`, not `listFlag`: `--output` is a repeatable flag and a comma-separated list cannot
 * express a path containing a comma, which a Windows user can type without noticing. The colon
 * is the separator, so `--output gif:a.png` is one entry and the role is a closed set.
 */
function parseOutputs(args: ParsedArgs): AssetMetaOutput[] {
  return repeatFlag(args.flags, 'output').map((entry) => {
    const colon = entry.indexOf(':');
    if (colon <= 0) throw new UsageError(`--output expects <role>:<path>, got "${entry}"`);
    const role = entry.slice(0, colon).trim();
    const path = entry.slice(colon + 1).trim();
    if (!(OUTPUT_ROLES as readonly string[]).includes(role)) {
      throw new UsageError(
        `--output role "${role}" is not one of ${OUTPUT_ROLES.join(', ')}; the sheet is \`--sheet\`, never an output role.`,
      );
    }
    if (path === '') throw new UsageError(`--output "${entry}" has no path after the colon`);
    return { role: role as AssetMetaOutput['role'], path };
  });
}

/**
 * Per-frame facing, one label per frame, `-`/`none`/empty for "this frame has none".
 *
 * Parsed from the raw string rather than through `listFlag`, because that one drops empty parts
 * and "S,,S" is a three-frame answer: a prop, a character, a prop again. Length is checked by
 * `buildAssetMeta`, which refuses rather than guessing — a dropped facing is a character facing
 * the wrong way with nothing to trace it back to.
 */
function parseDirections(args: ParsedArgs, frames: number): (string | null)[] | undefined {
  const raw = stringFlag(args.flags, 'directions');
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length !== frames) {
    throw new UsageError(
      `--directions has ${parts.length} label(s) for ${frames} frame(s); the contract writes one entry per frame. Use "-" for a frame with no facing.`,
    );
  }
  return parts.map((part) => (part === '' || part === '-' || part.toLowerCase() === 'none' ? null : part));
}

/**
 * The sheet to describe, when one was asked for.
 *
 * **The PNG is written by this command, not described from a file someone else packed.**
 * `sheet.regions` is authoritative in the contract precisely because the packer's padding and
 * margin are not recorded, so describing a sheet this command did not write would publish
 * geometry for an image that may not exist. Packing only, no I/O: the bytes are written after the
 * naming gate, so a refusal leaves nothing on disk at all.
 */
function packSheet(sprite: Sprite, ctx: CommandContext): { sheetPath: string; atlas: ReturnType<typeof buildSpritesheet> } | null {
  const sheetFlag = stringFlag(ctx.args.flags, 'sheet');
  if (!sheetFlag) return null;

  const scale = intFlag(ctx.args.flags, 'sheet-scale', 1)!;
  if (scale < 1) throw new UsageError('--sheet-scale must be at least 1');

  // Same flag names, defaults and validation as `pixel sheet`, deliberately, and not a second
  // spelling of them: describing a sheet packed differently from the one on disk is exactly the
  // failure the sentence above exists to prevent.
  const layout = stringFlag(ctx.args.flags, 'layout') as AtlasOptions['layout'] | undefined;
  const columns = intFlag(ctx.args.flags, 'columns');
  const padding = intFlag(ctx.args.flags, 'padding');
  const margin = intFlag(ctx.args.flags, 'margin');
  const options: AtlasOptions = {
    ...(layout ? { layout } : {}),
    ...(columns !== undefined ? { columns } : {}),
    ...(padding !== undefined ? { padding } : {}),
    ...(margin !== undefined ? { margin } : {}),
  };

  const atlas = buildSpritesheet(sprite, options);
  return { sheetPath: sheetFlag, atlas: scale === 1 ? atlas : scaleAtlas(atlas, scale) };
}

/**
 * The contract, built from the document and the caller's bundle options.
 *
 * `outputs` and `directions` are passed in rather than re-parsed, so the values reported in the
 * result envelope are the ones the contract was actually built from.
 */
function buildContract(
  sprite: Sprite,
  ctx: CommandContext,
  metaPath: string,
  outputs: readonly AssetMetaOutput[],
  directions: (string | null)[] | undefined,
  sheetRef: ReturnType<typeof packSheet>,
): AssetMeta {
  const licenseSpdx = stringFlag(ctx.args.flags, 'license');
  return buildAssetMeta(sprite, {
    ...(sheetRef ? { sheet: { atlas: sheetRef.atlas, image: bundleRelative(metaPath, sheetRef.sheetPath) } } : {}),
    outputs,
    directions,
    ...(licenseSpdx
      ? {
          license: {
            spdx: licenseSpdx,
            ...(stringFlag(ctx.args.flags, 'license-name') ? { name: stringFlag(ctx.args.flags, 'license-name')! } : {}),
            ...(stringFlag(ctx.args.flags, 'license-url') ? { url: stringFlag(ctx.args.flags, 'license-url')! } : {}),
            ...(stringFlag(ctx.args.flags, 'license-attribution')
              ? { attribution: stringFlag(ctx.args.flags, 'license-attribution')! }
              : {}),
          },
        }
      : {}),
  });
}

export const contractCommand: CommandSpec = {
  name: 'contract',
  summary: 'Write meta.json (and one engine\'s files) from a document',
  usage:
    'pixel contract <file.pixel> --out <meta.json> [--engine godot|unity|phaser|excalidraw] [--directory <dir>] ' +
    '[--sheet <file.png> [--layout horizontal|vertical|grid] [--columns <n>] [--padding <n>] [--margin <n>] [--sheet-scale <n>]] ' +
    '[--output <role>:<path>]... [--directions <N,NE,...,->] [--license <spdx>] [--license-name <s>] [--license-url <u>] [--license-attribution <s>]',
  async run(ctx) {
    const input = ctx.rest[0];
    if (!input) throw new UsageError('missing document path; see `pixel help`');
    const out = stringFlag(ctx.args.flags, 'out') ?? stringFlag(ctx.args.flags, 'o');
    if (!out) throw new UsageError('missing --out <meta.json>');

    const engine = stringFlag(ctx.args.flags, 'engine');
    if (engine !== undefined && !Object.prototype.hasOwnProperty.call(ENGINE_IMPORTERS, engine)) {
      throw new UsageError(`unknown --engine "${engine}"; expected ${Object.keys(ENGINE_IMPORTERS).join(', ')}`);
    }

    const sprite = await loadSprite(input);

    // Both parses happen before the sheet is written, so a malformed `--output` or a
    // `--directions` of the wrong length cannot leave half a bundle on disk.
    const outputs = parseOutputs(ctx.args);
    const directions = parseDirections(ctx.args, sprite.frames.length);
    const sheetRef = packSheet(sprite, ctx);
    const meta = buildContract(sprite, ctx, out, outputs, directions, sheetRef);

    // Naming runs on the contract, before the write and before the importer: a bundle whose own
    // names cannot be committed is not worth writing in the first place. Errors refuse; warnings
    // do not, and are reported so a project can see what its convention costs.
    const naming = validateAssetNaming(meta);
    if (!naming.ok) {
      const errors = naming.diagnostics.filter((d) => d.severity === 'error');
      const codes = [...new Set(errors.map((d) => d.code))].join(', ');
      const first = errors[0];
      return fail(
        `Asset naming refuses this bundle: ${errors.length} error(s) [${codes}]. ` +
          `First: ${first && first.path !== '' ? `"${first.path}"` : 'the contract'}` +
          (first ? ` - ${first.message}` : ''),
        {
          code: 'asset-naming',
          gate: 'asset-naming',
          naming: { ok: false, diagnostics: naming.diagnostics },
          remediation:
            'Rename the offending path or the asset name, or drop the entry from --output/--sheet, then re-run. Naming warnings do not block an export.',
        },
      );
    }

    // Serialised once and used twice, so the bytes written and the bytes reported are the same
    // bytes and a second call is not a second chance for them to differ.
    const text = serializeAssetMeta(meta);

    // Nothing above this line touched the disk, so a refusal really does write nothing at all.
    const written: string[] = [];
    if (sheetRef) {
      await writeBytes(sheetRef.sheetPath, encodePNG(sheetRef.atlas.image));
      written.push(resolve(sheetRef.sheetPath));
    }
    await writeText(out, text);
    written.unshift(resolve(out));

    let engineReport:
      | { engine: string; root: string; files: string[]; warnings: string[] }
      | undefined;
    if (engine !== undefined) {
      const result = ENGINE_IMPORTERS[engine]!(meta);
      // `result.root` is the importer's suggested folder; `--directory` takes it over, relative
      // to the contract. Paths are joined segment by segment so a Windows separator can never
      // reach a path that later becomes a contract field.
      const root = stringFlag(ctx.args.flags, 'directory') ?? result.root;
      for (const file of result.files) {
        const target = join(dirname(resolve(out)), root, ...file.path.split('/'));
        await writeText(target, file.contents);
        written.push(resolve(target));
      }
      engineReport = {
        engine,
        root,
        files: result.files.map((file) => file.path),
        warnings: [...result.warnings],
      };
    }

    // No score anywhere in this envelope. Named defects, code paths and file paths are the whole
    // report; a number here would be a target rather than a measurement.
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          path: out,
          bytes: Buffer.byteLength(text, 'utf8'),
          contentHash: meta.asset.contentHash,
          schemaVersion: meta.schemaVersion,
          asset: meta.asset.name,
          frames: meta.frames.count,
          sheet: sheetRef ? sheetRef.sheetPath : null,
          outputs,
          directions: directions ?? null,
          naming: { ok: naming.ok, diagnostics: naming.diagnostics },
          engine: engineReport ?? null,
          files: written,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  },
};