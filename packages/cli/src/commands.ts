import { basename, extname } from 'node:path';
import {
  Editor,
  allCommands,
  animationSequence,
  buildSpritesheet,
  compositeFrame,
  createEditor,
  createPalette,
  createSprite,
  describeCommands,
  encodeGIF,
  encodePNG,
  frameLayersWithCels,
  resolveFrame,
  scaleAtlas,
  isAseprite,
  spriteDurationMs,
  spriteFromAseprite,
  spriteFromPng,
  toAsepriteJson,
  toTiledJson,
  type AtlasOptions,
} from '@pixel/core';
import { boolFlag, intFlag, listFlag, stringFlag, UsageError, type ParsedArgs } from './args.js';
import { loadSprite, printJson, readBytes, readText, saveSprite, writeBytes, writeText } from './io.js';

export interface CommandContext {
  args: ParsedArgs;
  /** Positional arguments after the command name. */
  rest: string[];
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  run(ctx: CommandContext): Promise<number>;
}

function requirePath(ctx: CommandContext, what = 'file'): string {
  const path = ctx.rest[0];
  if (!path) throw new UsageError(`missing ${what} path; see \`pixel help\``);
  return path;
}

function withExtension(path: string, extension: string): string {
  return extname(path) === '' ? `${path}${extension}` : path;
}

function outputPath(ctx: CommandContext, fallback: string | null): string {
  const out = stringFlag(ctx.args.flags, 'out') ?? stringFlag(ctx.args.flags, 'o');
  if (out) return out;
  if (fallback) return fallback;
  throw new UsageError('missing --out <path>');
}

/* ------------------------------------------------------------------ new -- */

const newCommand: CommandSpec = {
  name: 'new',
  summary: 'Create an empty sprite document and save it as .pixel',
  usage: 'pixel new <file.pixel> --width <n> --height <n> [--name <s>] [--layers a,b] [--frames <n>] [--frame-duration <ms>] [--palette <hex,hex>]',
  async run(ctx) {
    const path = withExtension(requirePath(ctx), '.pixel');
    const width = intFlag(ctx.args.flags, 'width', intFlag(ctx.args.flags, 'w'));
    const height = intFlag(ctx.args.flags, 'height', intFlag(ctx.args.flags, 'h'));
    if (width === undefined || height === undefined) {
      throw new UsageError('missing --width and/or --height');
    }
    if (width <= 0 || height <= 0) throw new UsageError('--width and --height must be positive');

    const layers = listFlag(ctx.args.flags, 'layers');
    const palette = listFlag(ctx.args.flags, 'palette');

    const sprite = createSprite({
      width,
      height,
      name: stringFlag(ctx.args.flags, 'name') ?? basename(path, extname(path)),
      ...(layers ? { layers } : {}),
      ...(palette ? { palette: createPalette('Palette', palette) } : {}),
      ...(intFlag(ctx.args.flags, 'frames') !== undefined
        ? { frames: intFlag(ctx.args.flags, 'frames')! }
        : {}),
      ...(intFlag(ctx.args.flags, 'frame-duration') !== undefined
        ? { frameDurationMs: intFlag(ctx.args.flags, 'frame-duration')! }
        : {}),
    });

    await saveSprite(path, sprite);
    printJson({ ok: true, path, width, height, layers: sprite.layers.length, frames: sprite.frames.length });
    return 0;
  },
};

/* ----------------------------------------------------------------- info -- */

const infoCommand: CommandSpec = {
  name: 'info',
  summary: 'Print a JSON summary of a sprite document',
  usage: 'pixel info <file.pixel>',
  async run(ctx) {
    const path = requirePath(ctx);
    const sprite = await loadSprite(path);
    const celCount = sprite.frames.reduce((total, frame) => total + frame.cels.size, 0);
    printJson({
      path,
      id: sprite.id,
      name: sprite.name,
      width: sprite.width,
      height: sprite.height,
      durationMs: spriteDurationMs(sprite),
      layers: sprite.layers.map((layer, index) => ({
        index,
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        locked: layer.locked,
        opacity: layer.opacity,
        blendMode: layer.blendMode,
      })),
      frames: sprite.frames.map((frame, index) => ({
        index,
        id: frame.id,
        durationMs: frame.durationMs,
        layers: frameLayersWithCels(sprite, frame.id).map((layer) => layer.name),
      })),
      tags: sprite.tags,
      palette: {
        name: sprite.palette.name,
        size: sprite.palette.colors.length,
      },
      cels: celCount,
      hasTileset: sprite.tileset !== undefined,
      tilemaps: sprite.tilemaps?.map((tilemap) => ({
        id: tilemap.id,
        name: tilemap.name,
        width: tilemap.width,
        height: tilemap.height,
        tileWidth: tilemap.tileWidth,
        tileHeight: tilemap.tileHeight,
      })) ?? [],
    });
    return 0;
  },
};

/* --------------------------------------------------------------- export -- */

const exportCommand: CommandSpec = {
  name: 'export',
  summary: 'Render one frame (or every frame) to a PNG',
  usage: 'pixel export <file.pixel> --out <file.png> [--frame <n|id>] [--all] [--scale <n>] [--background <hex>]',
  async run(ctx) {
    const path = requirePath(ctx);
    const sprite = await loadSprite(path);
    const out = outputPath(ctx, null);
    const scale = intFlag(ctx.args.flags, 'scale', 1)!;
    if (scale < 1) throw new UsageError('--scale must be at least 1');
    const background = stringFlag(ctx.args.flags, 'background');

    const render = (frameId: string) => {
      const buffer = compositeFrame(sprite, frameId, background ? { background } : {});
      return encodePNG(scale === 1 ? buffer : buffer.scale(scale));
    };

    if (boolFlag(ctx.args.flags, 'all')) {
      const base = out.replace(/\.png$/i, '');
      const targets = sprite.frames.map((_frame, index) => `${base}_${index}.png`);
      await Promise.all(
        sprite.frames.map((frame, index) => writeBytes(targets[index]!, render(frame.id))),
      );
      printJson({ ok: true, frames: targets });
      return 0;
    }

    const frameRef = stringFlag(ctx.args.flags, 'frame');
    const frame = resolveFrame(sprite, frameRef === undefined ? 0 : (/^\d+$/.test(frameRef) ? Number(frameRef) : frameRef));
    await writeBytes(out, render(frame.id));
    printJson({ ok: true, path: out, frame: frame.id, width: sprite.width * scale, height: sprite.height * scale });
    return 0;
  },
};

/* ---------------------------------------------------------------- sheet -- */

const sheetCommand: CommandSpec = {
  name: 'sheet',
  summary: 'Export a spritesheet PNG plus Aseprite-compatible JSON metadata',
  usage: 'pixel sheet <file.pixel> --out <file.png> [--json <file.json>] [--layout horizontal|vertical|grid] [--columns <n>] [--padding <n>] [--margin <n>] [--scale <n>]',
  async run(ctx) {
    const path = requirePath(ctx);
    const sprite = await loadSprite(path);
    const out = outputPath(ctx, null);
    const scale = intFlag(ctx.args.flags, 'scale', 1)!;
    if (scale < 1) throw new UsageError('--scale must be at least 1');

    const layout = stringFlag(ctx.args.flags, 'layout') as AtlasOptions['layout'] | undefined;
    const options: AtlasOptions = {
      ...(layout ? { layout } : {}),
      ...(intFlag(ctx.args.flags, 'columns') !== undefined ? { columns: intFlag(ctx.args.flags, 'columns')! } : {}),
      ...(intFlag(ctx.args.flags, 'padding') !== undefined ? { padding: intFlag(ctx.args.flags, 'padding')! } : {}),
      ...(intFlag(ctx.args.flags, 'margin') !== undefined ? { margin: intFlag(ctx.args.flags, 'margin')! } : {}),
    };

    const atlas = buildSpritesheet(sprite, options);
    // Scale the atlas, not just its image, so the JSON frame rects and
    // `meta.size` match the PNG the engine will actually slice.
    const sheet = scaleAtlas(atlas, scale);
    await writeBytes(out, encodePNG(sheet.image));

    const jsonPath = stringFlag(ctx.args.flags, 'json') ?? `${out.replace(/\.png$/i, '')}.json`;
    const metadata = toAsepriteJson(sprite, sheet, basename(out));
    await writeText(jsonPath, `${JSON.stringify(metadata, null, 2)}\n`);

    printJson({
      ok: true,
      path: out,
      json: jsonPath,
      width: sheet.width,
      height: sheet.height,
      columns: atlas.columns,
      rows: atlas.rows,
      frames: atlas.frames.length,
      tags: atlas.tags.map((tag) => tag.name),
    });
    return 0;
  },
};

/* --------------------------------------------------------------- tiled -- */

const tiledCommand: CommandSpec = {
  name: 'tiled',
  summary: 'Export the tilemaps as a Tiled (.tmj) map',
  usage: 'pixel tiled <file.pixel> --out <file.tmj> [--image <tileset.png>] [--firstgid <n>]',
  async run(ctx) {
    const path = requirePath(ctx);
    const sprite = await loadSprite(path);
    const out = outputPath(ctx, null);
    if (!sprite.tileset) {
      throw new UsageError('This document has no tileset. Run `create_tileset` first.');
    }
    const tilemaps = sprite.tilemaps ?? [];
    if (tilemaps.length === 0) {
      throw new UsageError('This document has no tilemaps. Run `add_tilemap` first.');
    }

    const image = stringFlag(ctx.args.flags, 'image') ?? 'tileset.png';
    const firstgid = intFlag(ctx.args.flags, 'firstgid') ?? 1;
    const map = toTiledJson(sprite.tileset, tilemaps, { image, firstgid });
    await writeText(out, `${JSON.stringify(map, null, 2)}\n`);

    printJson({
      ok: true,
      path: out,
      image,
      firstgid,
      width: map.width,
      height: map.height,
      tileWidth: map.tilewidth,
      tileHeight: map.tileheight,
      layers: map.layers.map((layer) => layer.name),
      tiles: map.tilesets[0]?.tilecount ?? 0,
    });
    return 0;
  },
};

/* ----------------------------------------------------------------- gif -- */

const gifCommand: CommandSpec = {
  name: 'gif',
  summary: 'Export the animation as an animated GIF',
  usage: 'pixel gif <file.pixel> --out <file.gif> [--tag <name>] [--scale <n>] [--background <hex>] [--no-loop]',
  async run(ctx) {
    const path = requirePath(ctx);
    const sprite = await loadSprite(path);
    const out = outputPath(ctx, null);
    const scale = intFlag(ctx.args.flags, 'scale', 1)!;
    if (scale < 1) throw new UsageError('--scale must be at least 1');

    const tag = stringFlag(ctx.args.flags, 'tag');
    const background = stringFlag(ctx.args.flags, 'background') ?? null;
    // `--no-loop` forces a single play-through even for a tag that repeats forever.
    const loop = boolFlag(ctx.args.flags, 'loop') ? true : boolFlag(ctx.args.flags, 'no-loop') ? false : undefined;

    const bytes = encodeGIF(sprite, { tag, scale, background, loop });
    await writeBytes(out, bytes);

    const sequence = animationSequence(sprite, tag);
    printJson({
      ok: true,
      path: out,
      width: sprite.width * scale,
      height: sprite.height * scale,
      frames: sequence.frames.length,
      durationMs: sequence.durationMs,
      tag: sequence.name,
      loops: sequence.loops,
      bytes: bytes.length,
    });
    return 0;
  },
};

/* --------------------------------------------------------------- import -- */

const importCommand: CommandSpec = {
  name: 'import',
  summary: 'Import a PNG into a new .pixel document',
  usage: 'pixel import <file.png> --out <file.pixel> [--name <s>] [--layer <s>] [--no-palette] [--palette-limit <n>]',
  async run(ctx) {
    const path = requirePath(ctx, 'png');
    const bytes = await readBytes(path);
    const out = outputPath(ctx, withExtension(path.replace(/\.png$/i, ''), '.pixel'));
    // Aseprite files and PNGs both arrive here; the header tells them apart. An
    // Aseprite file brings its layers, frames, durations and tags with it.
    const sprite = isAseprite(bytes)
      ? spriteFromAseprite(bytes, {
          name: stringFlag(ctx.args.flags, 'name') ?? basename(path, extname(path)),
        })
      : spriteFromPng(bytes, {
          name: stringFlag(ctx.args.flags, 'name') ?? basename(path, extname(path)),
          ...(stringFlag(ctx.args.flags, 'layer') ? { layerName: stringFlag(ctx.args.flags, 'layer')! } : {}),
          derivePalette: !boolFlag(ctx.args.flags, 'no-palette'),
          ...(intFlag(ctx.args.flags, 'palette-limit') !== undefined
            ? { paletteLimit: intFlag(ctx.args.flags, 'palette-limit')! }
            : {}),
        });
    await saveSprite(out, sprite);
    printJson({
      ok: true,
      path: out,
      width: sprite.width,
      height: sprite.height,
      palette: sprite.palette.colors.length,
    });
    return 0;
  },
};

/* ---------------------------------------------------------------- apply -- */

interface Op {
  command: string;
  params?: Record<string, unknown>;
}

function normalizeOps(value: unknown): Op[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { ops?: unknown }).ops)
      ? (value as { ops: unknown[] }).ops
      : [value];

  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new UsageError(`op ${index} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const command = record.command ?? record.name;
    if (typeof command !== 'string') {
      throw new UsageError(`op ${index} is missing a "command" name`);
    }
    const params = record.params ?? record.args ?? record;
    return {
      command,
      params: params && typeof params === 'object' ? (params as Record<string, unknown>) : {},
    };
  });
}

const applyCommand: CommandSpec = {
  name: 'apply',
  summary: 'Run a list of core commands against a document (the scripted/AI entry point)',
  usage: 'pixel apply <file.pixel> --ops <ops.json> [--out <file.pixel>] [--dry-run]',
  async run(ctx) {
    const path = requirePath(ctx);
    const opsPath = stringFlag(ctx.args.flags, 'ops');
    if (!opsPath) throw new UsageError('missing --ops <ops.json>');
    const sprite = await loadSprite(path);
    const ops = normalizeOps(JSON.parse(await readText(opsPath)));

    const editor = createEditor(sprite);
    const results: unknown[] = [];
    let failed = 0;

    for (const op of ops) {
      const result = editor.tryExecute(op.command, op.params);
      if (result.ok) {
        results.push({ command: op.command, ok: true, summary: result.summary });
      } else {
        failed++;
        results.push({ command: op.command, ok: false, code: result.code, error: result.error });
      }
    }

    const out = stringFlag(ctx.args.flags, 'out') ?? path;
    if (!boolFlag(ctx.args.flags, 'dry-run')) await saveSprite(out, editor.sprite);

    printJson({ ok: failed === 0, applied: ops.length - failed, failed, version: editor.version, path: out, results });
    return failed === 0 ? 0 : 1;
  },
};

/* ------------------------------------------------------------- commands -- */

const commandsCommand: CommandSpec = {
  name: 'commands',
  summary: 'List every core command with its JSON schema (used by the MCP layer)',
  usage: 'pixel commands [--json]',
  async run(ctx) {
    const list = describeCommands(allCommands);
    if (boolFlag(ctx.args.flags, 'json')) {
      printJson({ commands: list });
      return 0;
    }
    for (const command of list) {
      process.stdout.write(`${command.name.padEnd(22)} ${command.description}\n`);
    }
    process.stdout.write(`\n${list.length} commands. Use --json for machine-readable schemas.\n`);
    return 0;
  },
};

/* ---------------------------------------------------------------- thumb -- */

const thumbCommand: CommandSpec = {
  name: 'thumb',
  summary: 'Write a small PNG preview of a document (cheap to send to a model)',
  usage: 'pixel thumb <file.pixel> --out <file.png> [--frame <n|id>] [--max <n>] [--background <hex>]',
  async run(ctx) {
    const path = requirePath(ctx);
    const sprite = await loadSprite(path);
    const out = outputPath(ctx, null);
    const max = intFlag(ctx.args.flags, 'max', 128)!;
    const background = stringFlag(ctx.args.flags, 'background');
    const frameRef = stringFlag(ctx.args.flags, 'frame');
    const frame = resolveFrame(sprite, frameRef === undefined ? 0 : (/^\d+$/.test(frameRef) ? Number(frameRef) : frameRef));

    let buffer = compositeFrame(sprite, frame.id, background ? { background } : {});
    const largest = Math.max(buffer.width, buffer.height);
    if (largest > max) {
      const factor = Math.max(1, Math.floor(max / largest));
      buffer = buffer.scale(factor);
    }
    await writeBytes(out, encodePNG(buffer));
    printJson({ ok: true, path: out, frame: frame.id, width: buffer.width, height: buffer.height });
    return 0;
  },
};

/* ------------------------------------------------------------- pipeline -- */

const pipelineCommand: CommandSpec = {
  name: 'pipeline',
  summary: 'Apply ops to a document and export the result in one call (AI batch workflow)',
  usage: 'pixel pipeline <file.pixel> --ops <ops.json> --out <file.png> [--scale <n>] [--background <hex>] [--save <file.pixel>] [--json <file.json>]',
  async run(ctx) {
    const path = requirePath(ctx);
    const opsPath = stringFlag(ctx.args.flags, 'ops');
    if (!opsPath) throw new UsageError('missing --ops <ops.json>');
    const sprite = await loadSprite(path);
    const ops = normalizeOps(JSON.parse(await readText(opsPath)));

    const editor = createEditor(sprite);
    const results: unknown[] = [];
    for (const op of ops) {
      const result = editor.tryExecute(op.command, op.params);
      results.push(
        result.ok
          ? { command: op.command, ok: true, summary: result.summary }
          : { command: op.command, ok: false, code: result.code, error: result.error },
      );
    }

    const out = outputPath(ctx, null);
    const scale = intFlag(ctx.args.flags, 'scale', 1)!;
    const background = stringFlag(ctx.args.flags, 'background');
    const frame = resolveFrame(editor.sprite, 0);
    const buffer = compositeFrame(editor.sprite, frame.id, background ? { background } : {});
    await writeBytes(out, encodePNG(scale === 1 ? buffer : buffer.scale(scale)));

    const save = stringFlag(ctx.args.flags, 'save');
    if (save) await saveSprite(save, editor.sprite);

    printJson({
      ok: results.every((entry) => (entry as { ok: boolean }).ok),
      path: out,
      applied: ops.length,
      version: editor.version,
      results,
    });
    return 0;
  },
};

/* --------------------------------------------------------------------- -- */

const pixelsCommand: CommandSpec = {
  name: 'pixels',
  summary: 'Read a rectangular region of the composited image as hex rows',
  usage: 'pixel pixels <file.pixel> [--frame <n|id>] [--rect x,y,w,h] [--max <n>]',
  async run(ctx) {
    const path = requirePath(ctx);
    const sprite = await loadSprite(path);
    const frameRef = stringFlag(ctx.args.flags, 'frame');
    const frame = resolveFrame(sprite, frameRef === undefined ? 0 : (/^\d+$/.test(frameRef) ? Number(frameRef) : frameRef));
    const buffer = compositeFrame(sprite, frame.id);

    const raw = listFlag(ctx.args.flags, 'rect');
    const rect = raw
      ? { x: Number(raw[0]), y: Number(raw[1]), w: Number(raw[2]), h: Number(raw[3]) }
      : { x: 0, y: 0, w: buffer.width, h: buffer.height };

    const max = intFlag(ctx.args.flags, 'max', 64)!;
    if (rect.w * rect.h > max * max) {
      throw new UsageError(`region is ${rect.w}x${rect.h}; pass --max to allow larger reads`);
    }

    const rows: string[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      let row = '';
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const index = (y * buffer.width + x) * 4;
        const a = buffer.data[index + 3]!;
        row += a === 0 ? '..' : buffer.data[index]!.toString(16).padStart(2, '0') + buffer.data[index + 1]!.toString(16).padStart(2, '0');
      }
      rows.push(row);
    }

    printJson({ frame: frame.id, rect, width: buffer.width, height: buffer.height, rows });
    return 0;
  },
};

export const COMMANDS: CommandSpec[] = [
  newCommand,
  infoCommand,
  exportCommand,
  sheetCommand,
  tiledCommand,
  gifCommand,
  importCommand,
  applyCommand,
  pipelineCommand,
  thumbCommand,
  pixelsCommand,
  commandsCommand,
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
