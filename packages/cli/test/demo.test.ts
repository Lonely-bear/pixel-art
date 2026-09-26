import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compositeFrame, packColor, resolveFrame } from '@pixel/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS, commandList, findCommand } from '../src/commands.js';
import { demoCommand, drawDemoSprite, runDemo } from '../src/demo.js';

describe('pixel demo', () => {
  it('is registered with a usage line that names both flags', () => {
    const spec = findCommand('demo');
    expect(spec).toBe(demoCommand);
    expect(COMMANDS.map((command) => command.name)).toContain('demo');
    expect(spec!.usage).toBe('pixel demo [--out <dir>] [--size <n>]');
  });

  it('appears in the command list `--help` renders', () => {
    const line = commandList().split('\n').find((entry) => entry.trim().startsWith('demo'));
    expect(line).toBeDefined();
    expect(line).toContain(demoCommand.summary);
  });

  it('draws through the command bus into a layered, animated, on-palette document', () => {
    const { sprite, commands } = drawDemoSprite();
    expect(commands).toBeGreaterThan(15);
    expect(sprite.width).toBe(32);
    expect(sprite.height).toBe(32);
    expect(sprite.layers.map((layer) => layer.name)).toEqual([
      'Base',
      'Shade',
      'Light',
      'Crown',
      'Face',
      'Outline',
    ]);
    expect(sprite.frames).toHaveLength(2);
    expect(sprite.tags.map((tag) => tag.name)).toEqual(['idle']);
    // A limited palette is part of the point, so a demo that grew one would be a
    // regression even though nothing else would notice: two neutrals, a five-step
    // jelly ramp and a three-step gold ramp, every one of them used.
    expect(sprite.palette.colors).toHaveLength(10);
    expect(Object.keys(sprite.palette.roles ?? {})).toHaveLength(8);
  });

  it('paints every pixel from the declared palette', async () => {
    const { sprite } = drawDemoSprite();
    const frame = resolveFrame(sprite, 0);
    const image = compositeFrame(sprite, frame.id);
    const declared = new Set(sprite.palette.colors.map((color) => packColor(color)));
    const used = new Set<number>();
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3]! < 128) continue;
      used.add(packColor({ r: image.data[i]!, g: image.data[i + 1]!, b: image.data[i + 2]!, a: image.data[i + 3]! }));
    }
    expect([...used].filter((color) => !declared.has(color))).toEqual([]);
    // Every one of the ten swatches is actually used. A dither between two *adjacent*
    // ramp steps adds no new colour, so this still holds with the one softened step in
    // the stack; a dither between two materials, or a colour invented outside the
    // ramps, would break it.
    expect(used.size).toBe(sprite.palette.colors.length);
  });

  it('lights the body from the upper left, which is the one rule the whole sprite obeys', () => {
    const { sprite } = drawDemoSprite();
    const frame = resolveFrame(sprite, 0);
    const image = compositeFrame(sprite, frame.id);
    // Green identifies the body's material by hue rather than by palette index, so the
    // assertion survives a reshuffle of the palette. Gold (r > g) and the two neutrals
    // are the crown and the contour, and neither says anything about the body's light.
    const jelly: { x: number; y: number; luma: number }[] = [];
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = image.index(x, y);
        if (image.data[i + 3]! < 128) continue;
        const r = image.data[i]!;
        const g = image.data[i + 1]!;
        if (g <= r) continue;
        jelly.push({ x, y, luma: 0.299 * r + 0.587 * g + 0.114 * image.data[i + 2]! });
      }
    }
    expect(jelly.length).toBeGreaterThan(200);
    // A key at the upper left means the light-facing half is the half with the small
    // x + y. This is the assertion the previous version failed: its lit planes were
    // insets, so the shoulder nearest the light came out darker than the middle.
    const sums = jelly.map((pixel) => pixel.x + pixel.y).sort((a, b) => a - b);
    const half = sums[Math.floor(sums.length / 2)]!;
    const mean = (pixels: typeof jelly) => pixels.reduce((total, pixel) => total + pixel.luma, 0) / pixels.length;
    const lit = mean(jelly.filter((pixel) => pixel.x + pixel.y <= half));
    const shadow = mean(jelly.filter((pixel) => pixel.x + pixel.y > half));
    expect(lit).toBeGreaterThan(shadow);
    // And not by a rounding error: a vignette and a key light produce the same ordering.
    expect(lit / shadow).toBeGreaterThan(1.5);
  });

  it('never lets the core shadow reach the silhouette, so the bounce is outboard of it', () => {
    const { sprite } = drawDemoSprite();
    const frame = resolveFrame(sprite, 0);
    const image = compositeFrame(sprite, frame.id);
    const key = (r: number, g: number, b: number, a: number) => packColor({ r, g, b, a });
    const swatch = (index: number) => {
      const color = sprite.palette.colors[index]!;
      return key(color.r, color.g, color.b, color.a);
    };
    const contour = swatch(0);
    const dark = swatch(2);
    const solid = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < image.width && y < image.height && image.data[image.index(x, y) + 3]! >= 128;
    const at = (x: number, y: number) => {
      const i = image.index(x, y);
      return key(image.data[i]!, image.data[i + 1]!, image.data[i + 2]!, image.data[i + 3]!);
    };
    // The sprite's own edge: the contour pixel ring, not the interior contour lines. The
    // crown's seat line and its notches are also drawn in the contour colour and are
    // interior, so "adjacent to the contour" on its own would flag the head's core shadow
    // sitting under the crown, which is correct and not what this test is about.
    const edge = new Set<string>();
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (!solid(x, y) || at(x, y) !== contour) continue;
        if (!solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1)) edge.add(`${x},${y}`);
      }
    }
    expect(edge.size).toBeGreaterThan(0);
    // The darkest ramp step is the core shadow, and the base tone outboard of it is the
    // reflected-light bounce. The bounce is what stops the lower right from going dead, and
    // it only exists if the core shadow never reaches the silhouette — which a pure
    // translation cannot guarantee, because its crescent depth goes to zero at the two
    // points where the contour runs parallel to the light. Hence the core plane's inset.
    const coreOnEdge: string[] = [];
    for (const cell of edge) {
      const [x, y] = cell.split(',').map(Number) as [number, number];
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx!;
        const ny = y + dy!;
        if (solid(nx, ny) && at(nx, ny) === dark) coreOnEdge.push(`${nx},${ny}`);
      }
    }
    expect(coreOnEdge).toEqual([]);
  });

  it('rejects a size that is not a positive integer multiple', async () => {
    await expect(runDemo({ size: 0 })).rejects.toThrow(/1 to 16/);
    await expect(runDemo({ size: 17 })).rejects.toThrow(/1 to 16/);
    await expect(runDemo({ size: 2.5 })).rejects.toThrow(/1 to 16/);
  });
});

describe('pixel demo output', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pixel-demo-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a PNG and an editable .pixel beside each other, and prints one JSON object', async () => {
    const written: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    let code: number;
    let result: Awaited<ReturnType<typeof runDemo>>;
    try {
      result = await runDemo({ out: dir, size: 4 });
      code = await demoCommand.run({
        args: { command: 'demo', positionals: [], flags: { out: dir, size: '4' } },
        rest: [],
      });
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }

    expect(code).toBe(0);
    // Exactly one JSON object: a second document on stdout would break every caller.
    expect(written).toHaveLength(1);
    const printed = JSON.parse(written[0]!);
    expect(printed).toEqual(result);
    expect(printed.ok).toBe(true);
    expect(printed.path).toBe(join(dir, 'crowned-slime.png'));
    expect(printed.source).toBe(join(dir, 'crowned-slime.pixel'));
    expect(printed.width).toBe(128);
    expect(printed.height).toBe(128);

    const png = await readFile(printed.path);
    // PNG signature plus a non-trivial IHDR, so a zero-byte or truncated file fails.
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
    expect((await stat(printed.source)).size).toBeGreaterThan(0);
  });
});
