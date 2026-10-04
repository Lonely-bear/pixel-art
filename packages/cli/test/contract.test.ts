/**
 * `pixel contract` — the round trip through the real binary.
 *
 * Every case here spawns `packages/cli/dist/index.js` as a child process rather than importing
 * the command spec, because the thing being tested is the CLI's surface: the JSON on stdout, the
 * bytes on disk, and the exit code. Calling `contractCommand.run()` in-process would skip all
 * three of those and would pass while the binary was broken.
 *
 * **This test needs a built CLI and a built `@pixel/core`.** Both are `dist/`, both are shared
 * with other packages, so a stale build makes this file lie. Run `pnpm build:libs` first if a
 * case fails on a field this file does not mention. It never invokes `build-npm-package.mjs` and
 * never touches the root `dist/`.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(REPO, 'packages', 'cli', 'dist', 'index.js');

/** Every case spawns Node at least twice, and Windows process start is not cheap. */
const SPAWN_TIMEOUT = 60_000;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function pixel(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: REPO,
      maxBuffer: 16 * 1024 * 1024,
      timeout: SPAWN_TIMEOUT,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    // `execFile` rejects on a non-zero exit, which is the interesting half of a refusal test.
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function json(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

let dir: string;
/** A two-frame, two-layer 16x16 sprite named `hero-idle` with one looping `idle` tag. */
let document: string;

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The entries of a directory the command was supposed to fill, treating "no such directory" as
 * empty.
 *
 * That tolerance is the point rather than a convenience: `writeBytes` creates the parent folder,
 * so a directory that does not exist afterwards is the strongest statement a refusal can make -
 * not "the files were cleaned up" but "nothing was ever created".
 */
async function entriesOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

beforeAll(async () => {
  if (!(await exists(CLI))) {
    throw new Error(
      `${CLI} does not exist. This suite drives the built CLI, so run \`pnpm build:libs\` first — \`pnpm --filter @pixel/cli test\` skips that step and would test the last build.`,
    );
  }
  dir = await mkdtemp(join(tmpdir(), 'pixel-contract-'));
  document = join(dir, 'hero-idle.pixel');

  // Authored through the binary, so the fixture cannot drift from what `pixel new` really
  // produces. Content, not ids: `asset.contentHash` excludes every document id, so this is stable
  // across runs and machines.
  const created = await pixel([
    'new',
    document,
    '--width',
    '16',
    '--height',
    '16',
    '--frames',
    '2',
    '--name',
    'hero-idle',
    '--layers',
    'Ink,Shade',
    '--palette',
    '#101820,#3a6ea5,#f2c14e',
  ]);
  expect(created.code).toBe(0);

  const ops = join(dir, 'ops.json');
  await writeFile(
    ops,
    JSON.stringify({
      ops: [
        {
          command: 'draw_rect',
          params: { layer: 'Ink', frame: 0, rect: { x: 3, y: 4, w: 10, h: 9 }, color: '#3a6ea5', fill: true },
        },
        {
          command: 'draw_rect',
          params: { layer: 'Ink', frame: 1, rect: { x: 3, y: 5, w: 10, h: 8 }, color: '#3a6ea5', fill: true },
        },
        { command: 'upsert_tags', params: { tags: [{ name: 'idle', from: 0, to: 1, repeat: 0 }] } },
      ],
    }),
  );
  const applied = await pixel(['apply', document, '--ops', ops]);
  expect(applied.code).toBe(0);
}, SPAWN_TIMEOUT);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('pixel contract - clean run', () => {
  it('writes meta.json, the sheet and the engine files, and reports them on stdout', async () => {
    const bundle = join(dir, 'clean');
    const meta = join(bundle, 'hero-idle.meta.json');
    const result = await pixel([
      'contract',
      document,
      '--out',
      meta,
      '--engine',
      'godot',
      '--sheet',
      join(bundle, 'hero-idle-sheet.png'),
      '--output',
      'gif:hero-idle.gif',
      '--output',
      'source:hero-idle.pixel',
      '--directions',
      'S,-',
      '--license',
      'CC0-1.0',
    ]);

    expect(result.code).toBe(0);
    const report = json(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.schemaVersion).toBe(1);
    expect(report.asset).toBe('hero-idle');
    expect(report.frames).toBe(2);

    // Every path reported is a file that exists, and every path written is reported.
    const files = report.files as string[];
    expect(files).toHaveLength(5);
    for (const file of files) expect(existsSync(file)).toBe(true);

    // Naming ran, and it passed. Warnings are reported even when they do not block.
    const naming = report.naming as { ok: boolean; diagnostics: unknown[] };
    expect(naming.ok).toBe(true);
    expect(naming.diagnostics).toEqual([]);

    const engine = report.engine as { engine: string; root: string; files: string[]; warnings: string[] };
    expect(engine.engine).toBe('godot');
    expect(engine.root).toBe('hero-idle');
    expect(engine.files).toContain('hero-idle.tres');
    expect(engine.warnings).toEqual([]);
  }, SPAWN_TIMEOUT);

  it('writes a contract that validates, with the sheet described relatively and the sheet on disk', async () => {
    const bundle = join(dir, 'validate');
    const meta = join(bundle, 'hero-idle.meta.json');
    const sheet = join(bundle, 'hero-idle-sheet.png');
    const result = await pixel(['contract', document, '--out', meta, '--sheet', sheet]);
    expect(result.code).toBe(0);

    const contract = json(await readFile(meta, 'utf8')) as Record<string, any>;
    expect(contract.format).toBe('dotloom-mcp/asset-meta');
    // Relative and forward-slashed, per S5.1 - a path from the artist's machine does not survive
    // being moved into a game project.
    expect(contract.sheet.image).toBe('hero-idle-sheet.png');
    expect(contract.sheet.regions).toHaveLength(2);
    expect(contract.frames.durationsMs).toEqual([100, 100]);
    // The pixels the contract points at are the pixels this command wrote.
    expect(existsSync(sheet)).toBe(true);
  }, SPAWN_TIMEOUT);

  it('omits the sheet and the directions block entirely when neither was asked for', async () => {
    const bundle = join(dir, 'bare');
    const meta = join(bundle, 'hero-idle.meta.json');
    const result = await pixel(['contract', document, '--out', meta]);
    expect(result.code).toBe(0);

    const report = json(result.stdout);
    expect(report.sheet).toBeNull();
    expect(report.directions).toBeNull();
    expect(report.engine).toBeNull();

    const contract = json(await readFile(meta, 'utf8')) as Record<string, any>;
    // Absent rather than empty: a file claiming to know something nobody recorded is a worse
    // signal than the absence, and S11 requires these assets to serialise unchanged.
    expect(contract.sheet).toBeUndefined();
    expect(contract.frames.directions).toBeUndefined();
    expect(contract.license).toBeUndefined();
  }, SPAWN_TIMEOUT);

  it('writes byte-identical bytes for the same document twice', async () => {
    const first = join(dir, 'determinism-a', 'hero-idle.meta.json');
    const second = join(dir, 'determinism-b', 'hero-idle.meta.json');
    const a = await pixel([
      'contract', document, '--out', first, '--engine', 'phaser',
      '--sheet', join(dir, 'determinism-a', 'hero-idle-sheet.png'),
    ]);
    const b = await pixel([
      'contract', document, '--out', second, '--engine', 'phaser',
      '--sheet', join(dir, 'determinism-b', 'hero-idle-sheet.png'),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);

    // Absolute paths differ between the two runs, so the contract must not contain one - that is
    // the whole point of S5.1, and a stub comparing file bytes would miss it.
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'));
    expect(json(a.stdout).contentHash).toBe(json(b.stdout).contentHash);

    const sheetA = await readFile(join(dir, 'determinism-a', 'hero-idle-sheet.png'));
    const sheetB = await readFile(join(dir, 'determinism-b', 'hero-idle-sheet.png'));
    expect(Buffer.compare(sheetA, sheetB)).toBe(0);
  }, SPAWN_TIMEOUT);

  it('reaches all four engines', async () => {
    for (const engine of ['godot', 'unity', 'phaser', 'excalidraw']) {
      const bundle = join(dir, `engine-${engine}`);
      const result = await pixel([
        'contract', document, '--out', join(bundle, 'hero-idle.meta.json'), '--engine', engine,
      ]);
      expect(result.code, `${engine} should succeed`).toBe(0);
      const report = json(result.stdout);
      const written = report.engine as { files: string[]; warnings: string[] };
      expect(written.files.length).toBeGreaterThan(0);
      // Every file the importer claims is a file on disk, in the directory it claimed.
      for (const relative of written.files) {
        expect(existsSync(join(bundle, 'hero-idle', ...relative.split('/'))), `${engine}/${relative}`).toBe(true);
      }
    }
  }, SPAWN_TIMEOUT * 4);

  it('honours --directory over the importer\'s suggested root', async () => {
    const bundle = join(dir, 'directory');
    const result = await pixel([
      'contract', document, '--out', join(bundle, 'hero-idle.meta.json'),
      '--engine', 'unity', '--directory', 'Assets/Dotloom',
    ]);
    expect(result.code).toBe(0);
    const engine = json(result.stdout).engine as { root: string; files: string[] };
    expect(engine.root).toBe('Assets/Dotloom');
    for (const relative of engine.files) {
      expect(existsSync(join(bundle, 'Assets', 'Dotloom', ...relative.split('/')))).toBe(true);
    }
    // And nothing landed under the importer's own suggestion.
    expect(await readdir(bundle)).not.toContain('hero-idle');
  }, SPAWN_TIMEOUT);
});

describe('pixel contract - naming gate', () => {
  it('refuses a reserved device name, writes nothing, and names the offending path', async () => {
    const bundle = join(dir, 'refuse-reserved');
    const result = await pixel([
      'contract', document, '--out', join(bundle, 'hero-idle.meta.json'),
      '--engine', 'phaser', '--output', 'frame:nul.png',
    ]);

    // Non-zero, not a stack trace, and nothing on disk: a bundle nobody can commit is worse than
    // no bundle, and the failure has to be the CLI's exit code or a build script will not see it.
    expect(result.code).toBe(1);
    const failure = json(result.stderr);
    expect(failure.ok).toBe(false);
    expect(failure.code).toBe('asset-naming');
    expect(String(failure.error)).toContain('reserved-name');
    expect(String(failure.error)).toContain('nul.png');

    // The diagnostics travel with the failure, machine-readable, so a fixer branches on `code`.
    const naming = failure.naming as { ok: boolean; diagnostics: { code: string; severity: string; path: string }[] };
    expect(naming.ok).toBe(false);
    const errors = naming.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.map((d) => d.code)).toContain('reserved-name');
    expect(errors[0].path).toBe('outputs[0].path');
    // A style warning rode along and did not block; only the error did.
    expect(naming.diagnostics.some((d) => d.severity === 'warning')).toBe(true);

    expect(await entriesOrEmpty(bundle)).toEqual([]);
  }, SPAWN_TIMEOUT);

  it('refuses a case-folded collision between two bundle paths', async () => {
    const bundle = join(dir, 'refuse-case');
    const result = await pixel([
      'contract', document, '--out', join(bundle, 'hero-idle.meta.json'),
      '--output', 'frame:hero-idle.png', '--output', 'frame:HERO-IDLE.png',
    ]);
    expect(result.code).toBe(1);
    expect(json(result.stderr).code).toBe('asset-naming');
    expect(String(json(result.stderr).error)).toContain('case-collision');
    expect(await entriesOrEmpty(bundle)).toEqual([]);
  }, SPAWN_TIMEOUT);

  it('does not write the sheet when the gate refuses', async () => {
    const bundle = join(dir, 'refuse-no-sheet');
    const result = await pixel([
      'contract', document, '--out', join(bundle, 'hero-idle.meta.json'),
      '--sheet', join(bundle, 'hero-idle-sheet.png'), '--output', 'gif:aux/hero-idle.gif',
    ]);
    expect(result.code).toBe(1);
    // The sheet is packed before the gate and written after it, so a refusal leaves no image
    // beside a contract that was never written.
    expect(await entriesOrEmpty(bundle)).toEqual([]);
  }, SPAWN_TIMEOUT);

  it('lets a naming warning through and reports it', async () => {
    const bundle = join(dir, 'warn');
    const camel = join(dir, 'HeroIdle.pixel');
    await pixel(['new', camel, '--width', '8', '--height', '8', '--name', 'HeroIdle']);
    const result = await pixel(['contract', camel, '--out', join(bundle, 'meta.json')]);

    // A convention, not a broken build. A validator that blocks over style is one a project
    // switches off, and then nothing is checked at all.
    expect(result.code).toBe(0);
    const naming = json(result.stdout).naming as { ok: boolean; diagnostics: { code: string; severity: string }[] };
    expect(naming.ok).toBe(true);
    expect(naming.diagnostics.map((d) => d.code)).toContain('asset-name-style');
  }, SPAWN_TIMEOUT);
});

describe('pixel contract - usage', () => {
  it('exits 2 on a mistyped flag rather than guessing', async () => {
    const cases: [string[], string][] = [
      // `sheet` is reserved by the contract: the sheet path is `sheet.image`, and listing it
      // twice gives one path two chances to disagree. Rejected as a usage error, not a default.
      [['--output', 'sheet:hero-idle.png'], 'never an output role'],
      [['--output', 'nonsense'], '<role>:<path>'],
      [['--output', 'gif:'], 'no path'],
      [['--engine', 'unreal'], 'unknown --engine'],
      [['--directions', 'S'], '2 frame(s)'],
      [['--sheet', 'a.png', '--sheet-scale', '0'], '--sheet-scale'],
    ];
    for (const [extra, expected] of cases) {
      const result = await pixel([
        'contract', document, '--out', join(dir, 'usage', 'hero-idle.meta.json'), ...extra,
      ]);
      expect(result.code, extra.join(' ')).toBe(2);
      expect(String(json(result.stderr).error)).toContain(expected);
    }
  }, SPAWN_TIMEOUT);

  it('refuses a document it cannot describe rather than writing a wrong contract', async () => {
    const tiled = join(dir, 'tiled.pixel');
    const created = await pixel(['new', tiled, '--width', '8', '--height', '8', '--name', 'tiled-map']);
    expect(created.code).toBe(0);
    const ops = join(dir, 'tileset-ops.json');
    await writeFile(
      ops,
      JSON.stringify({
        ops: [
          {
            command: 'draw_rect',
            params: { layer: 0, frame: 0, rect: { x: 0, y: 0, w: 8, h: 8 }, color: '#3a6ea5', fill: true },
          },
          {
            command: 'create_tileset',
            params: { layer: 0, frame: 0, name: 'tiles', tileWidth: 8, tileHeight: 8 },
          },
        ],
      }),
    );
    // `create_tileset` cuts the tiles out of real pixels, so the fixture needs a drawn layer -
    // an empty one has nothing to cut and the op fails for an unrelated reason.
    const applied = await pixel(['apply', tiled, '--ops', ops]);
    expect(applied.code, applied.stdout).toBe(0);

    const result = await pixel(['contract', tiled, '--out', join(dir, 'tiled.meta.json')]);
    expect(result.code).toBe(1);
    expect(String(result.stderr)).toContain('tileset');
  }, SPAWN_TIMEOUT);

  it('prints no score anywhere in the success envelope', async () => {
    // A number an agent can see becomes the target instead of the artwork; `quality_report` was
    // deleted in 0.3.1 for exactly this. Guarded rather than trusted, because the temptation is
    // one field away.
    const result = await pixel([
      'contract', document, '--out', join(dir, 'noscore', 'hero-idle.meta.json'), '--engine', 'godot',
    ]);
    expect(result.code).toBe(0);
    const forbidden = ['score', 'quality', 'rating', 'grade', 'overall', 'total'];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          expect(forbidden, `unexpected key "${key}"`).not.toContain(key);
          walk(child);
        }
      }
    };
    walk(json(result.stdout));
  }, SPAWN_TIMEOUT);
});

