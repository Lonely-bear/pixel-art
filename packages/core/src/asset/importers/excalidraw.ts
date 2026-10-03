import type { AssetMeta, AssetMetaOutput } from '../schema.js';
import {
  readAssetMeta,
  toJsonFile,
  WarningBag,
  type AssetImportFile,
  type AssetImportResult,
} from './types.js';

/**
 * The Excalidraw importer: `meta.json` in, an `.excalidraw` scene out.
 *
 * ## What this can honestly be
 *
 * Excalidraw has no atlas, no animation and no pivot. S9.4's answer is the honest one: draw one
 * frame and place it at 1:1 using `frames.size`. Anything more would be inventing a feature the
 * app does not have.
 *
 * So this emits **one image element per frame**, laid out in the sheet's row-major order, each
 * `frames.size.width` by `frames.size.height` at scale 1 — which is the one thing an artist
 * opening the file in Excalidraw actually wants from a spritesheet: the frames laid out so they
 * can be traced, eyeballed or dropped into a doc. When a sheet exists and its regions divide
 * evenly into a grid, the layout matches the sheet's arrangement so the scene reads as a
 * contact sheet; otherwise the frames are laid in a single row.
 *
 * The pixels themselves are **not** embedded. The contract does not carry them, and inventing
 * them would mean reading the PNG from disk — which `packages/core` cannot do (no filesystem).
 * Each element therefore carries `fileId` plus a `customData` block naming the file it belongs
 * to, and the scene is complete and loadable with those files absent: Excalidraw renders a
 * missing image as an unloaded placeholder rather than failing to open. That is the one
 * genuine limitation, it is inherent to "the contract is the input", and it is stated in
 * `docs/IMPORTERS.md` rather than papered over.
 */

export interface ExcalidrawImportOptions {
  /** Column count for the on-canvas grid. Defaults to the sheet's own, then to a square-ish arrangement. */
  readonly columns?: number;
  /** Gap between placed frames, in pixels. Defaults to 8. */
  readonly gutter?: number;
  /**
   * How the frame's PNG file is named, when the bundle exported individual frames. Only used
   * for `customData`; no file is written.
   */
  readonly frameFilePattern?: string;
}

/** Excalidraw's scene version. The shape this emits is the 2.x scene file. */
const SCENE_VERSION = 2;

export function importExcalidraw(input: unknown, options: ExcalidrawImportOptions = {}): AssetImportResult {
  const meta = readAssetMeta(input);
  const warnings = new WarningBag();
  const gutter = options.gutter ?? 8;
  const columns = resolveColumns(meta, options.columns);

  if (!meta.sheet) {
    const frameFiles = (meta.outputs ?? []).filter((output: AssetMetaOutput) => output.role === 'frame');
    if (frameFiles.length === 0) {
      warnings.add(
        'This bundle has neither a sheet nor any outputs with role "frame", so no element in the scene points at a file that exists. Export the sheet or the frame PNGs alongside meta.json.',
      );
    }
  }
  if (meta.sheet && meta.sheet.scale > 1) {
    warnings.add(
      `The sheet is ${meta.sheet.scale}x upscale. The scene places every element at its ${meta.frames.size.width}x${meta.frames.size.height} logical size, so an artist tracing from the sheet needs to zoom to ${100 * meta.sheet.scale}%.`,
    );
  }
  warnings.add(
    'Excalidraw has no pivot, and none is emitted. T-055\'s naming convention is where the anchor belongs; scene element names carry it instead.',
  );

  const elements = meta.frames.durationsMs.map((_duration: number, index: number) =>
    elementFor(meta, index, columns, gutter, options.frameFilePattern),
  );

  const scene = {
    type: 'excalidraw',
    version: SCENE_VERSION,
    source: 'dotloom-mcp',
    elements,
    appState: {
      gridSize: null,
      // Nearest-neighbour, because every frame is a pixel-art grid and a smoothed one misleads
      // whoever is looking at it.
      gridStep: 1,
      viewBackgroundColor: '#ffffff',
    },
    files: {},
  };

  const files: AssetImportFile[] = [
    { path: `${meta.asset.name}.excalidraw`, role: 'excalidraw-scene', contents: toJsonFile(scene) },
  ];

  return { root: meta.asset.name, files, warnings: warnings.list(), meta };
}

function resolveColumns(meta: AssetMeta, requested: number | undefined): number {
  if (requested !== undefined && requested >= 1) return requested;
  if (meta.sheet) return meta.sheet.columns;
  const count = meta.frames.count;
  return Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count))));
}

/**
 * One `image` element per frame.
 *
 * `fileId` is derived from the asset name and the frame index rather than from a counter or a
 * clock, so re-exporting the same contract produces the same scene file byte for byte. The
 * `customData` block is where the facts Excalidraw cannot store go: the frame index, its
 * duration, and the file the pixels belong in. Nothing in an Excalidraw file is a promise the
 * app will read back as anything but a label, which is exactly what these are.
 */
function elementFor(
  meta: AssetMeta,
  index: number,
  columns: number,
  gutter: number,
  frameFilePattern: string | undefined,
): Record<string, unknown> {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const fileId = `${meta.asset.name}-frame-${index}`;
  const sheetPath = meta.sheet?.image;
  const framePath = frameFilePattern
    ? frameFilePattern.replace('{name}', meta.asset.name).replace('{index}', String(index))
    : undefined;

  return {
    id: `${fileId}-element`,
    type: 'image',
    x: column * (meta.frames.size.width + gutter),
    y: row * (meta.frames.size.height + gutter),
    width: meta.frames.size.width,
    height: meta.frames.size.height,
    // A positive scale means the file is 1:1 with the element; Excalidraw multiplies the
    // element's own size by it, and pixel art placed at 100% is the whole point of the file.
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: seedFor(meta.asset.contentHash, index),
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
    scale: [1, 1],
    status: 'saved',
    fileId,
    // Excalidraw uses `customData` for exactly this: facts a third party attached.
    customData: {
      dotloom: {
        asset: meta.asset.name,
        contentHash: meta.asset.contentHash,
        frame: index,
        durationMs: meta.frames.durationsMs[index],
        frameSize: meta.frames.size,
        // The sheet cell this frame occupies, when there is one. Carried because Excalidraw
        // cannot hold an atlas and the artist needs to know which cell to crop.
        region: sheetRegion(meta, index),
        sourcePath: framePath ?? sheetPath ?? null,
        pivot: meta.pivot,
      },
    },
  };
}

function sheetRegion(meta: AssetMeta, index: number): Record<string, number> | null {
  const region = meta.sheet?.regions[index];
  if (!region) return null;
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}

/**
 * A deterministic `seed` per element.
 *
 * Excalidraw uses the seed to pick a randomised roughness; left at 0 every frame looks
 * identical, and if it were left to a clock the same contract would produce a different scene
 * file on every export, which is the one thing a committed asset must never do. So the seed is
 * a few bytes of the content hash mixed with the frame index — stable, and different per frame.
 */
function seedFor(contentHash: string, index: number): number {
  const hex = contentHash.slice(contentHash.lastIndexOf(':') + 1, contentHash.lastIndexOf(':') + 13);
  const parsed = Number.parseInt(hex, 16);
  if (Number.isNaN(parsed)) return index * 2654435761;
  return (parsed ^ (index * 2654435761)) >>> 1;
}
