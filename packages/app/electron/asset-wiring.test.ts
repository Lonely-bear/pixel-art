/**
 * The asset-export capability has to exist in **four** places: the channel table, the
 * `PixelApi` declaration, the preload bridge and the main handler. Any three of the four
 * is the exact failure this file exists to catch — it typechecks, `ipcRenderer.invoke`
 * only fails when the button is pressed, and the error it produces is
 * "No handler registered for ...", which names the channel and nothing about the cause.
 *
 * The wiring checks are text assertions over the sources rather than runtime ones,
 * because two of the four (`shared/types.ts`, `preload.cts`) cannot be imported without
 * Electron in the picture. What makes them more than string matching is
 * `const typed: PixelApi = api` at the bottom of the preload: a channel that exists in
 * `CHANNELS` but not on `PixelApi` cannot be written into the bridge without
 * `tsconfig.json` failing. Each assertion below says which is load-bearing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSprite } from '@pixel/core';
import { describe, expect, it } from 'vitest';
import { ASSET_ENGINES, exportAssetBundle, type AssetExportResult, type AssetEngine } from './asset-export.js';
import { ASSET_ENGINES as SHARED_ENGINES } from '../shared/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string): string => readFileSync(path.join(here, file), 'utf8');

const SHARED = source('../shared/types.ts');
const PRELOAD = source('preload.cts');
const IPC = source('ipc.ts');

/** `pixel:export-meta` -> `exportMeta`. The `CHANNELS` key for a channel name. */
function camel(channel: string): string {
  return channel
    .split(':')[1]!
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Every capability is checked by the same four rules, so they are data here. */
const CAPABILITIES = [
  { api: 'exportMeta', channel: 'pixel:export-meta' },
  { api: 'exportEngine', channel: 'pixel:export-engine' },
] as const;

describe('asset export is wired in all four places', () => {
  for (const capability of CAPABILITIES) {
    it(`${capability.api}: CHANNELS, PixelApi, the preload bridge and a main handler`, () => {
      // 1. The channel table. Load-bearing: the preload spells the string out by hand,
      //    because a sandboxed preload cannot import the module that declares it.
      expect(SHARED).toContain(`${camel(capability.channel)}: '${capability.channel}',`);
      // 2. `PixelApi`. Load-bearing through `const typed: PixelApi = api` in the preload.
      expect(SHARED).toMatch(new RegExp(`\\n  ${capability.api}\\(`));
      // 3. The bridge. Written by hand against the channel string, so this is where a
      //    typo actually happens, and nothing else would notice.
      expect(PRELOAD).toContain(`${capability.api}: (id: string | undefined`);
      expect(PRELOAD).toContain(`'${capability.channel}'`);
      // 4. The main handler, which is the only writer.
      expect(IPC).toContain(`CHANNELS.${camel(capability.channel)}`);
    });
  }

  it('every PixelApi method has a preload call, and the bridge adds none', () => {
    // Drift in *either* direction is the same bug: a channel nobody can call, or a
    // method the preload never implements. `typed: PixelApi = api` catches the second
    // for real; this catches the first, which tsc cannot see.
    const declared = [...SHARED.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]!);
    const subscriptions = new Set([
      'onChanged',
      'onCommand',
      'onWindowState',
      'onUpdateEvent',
    ]);
    for (const name of declared) {
      if (subscriptions.has(name)) continue;
      expect(PRELOAD, `${name} is on PixelApi but not in the preload bridge`).toContain(
        `${name}: (`,
      );
    }
    const bridged = [...PRELOAD.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);
    for (const name of bridged) {
      expect(declared, `${name} is in the bridge but not on PixelApi`).toContain(name);
    }
  });

  it('the shared engine list is the same four engines core ships', () => {
    // `shared/types.ts` is what the renderer and the preload type against; a fifth
    // importer added to core and not here is invisible from the GUI, which is exactly
    // the sort of drift this file is for.
    expect([...SHARED_ENGINES]).toEqual([...ASSET_ENGINES]);
    expect([...ASSET_ENGINES]).toEqual(['godot', 'unity', 'phaser', 'excalidraw']);
  });
});

/**
 * The policy, exercised for real.
 *
 * The contract and the importers are already tested in `packages/core`; what is untested
 * anywhere is what this handler *does* with their output, and that is the half that can
 * disagree with `finalize_document`. So these are the two decisions that must match: a
 * naming error refuses and writes nothing, and an engine export carries the contract.
 *
 * Real files in a temp directory, because a test that asserts a refusal while writing to
 * a mock proves nothing about the refusal.
 */
describe('exportAssetBundle', () => {
  it('writes the contract and refuses nothing on a clean name', async () => {
    const dir = await tempDir();
    const result = await run(dir, 'hero');
    expect(result.written).toBe(true);
    expect(result.naming.ok).toBe(true);
    expect(result.metaPath).toBe(path.join(dir, 'hero', 'meta.json'));
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(listFiles(dir)).toEqual(['hero/meta.json']);
    expect(JSON.parse(read(dir, 'hero/meta.json')).format).toBe('dotloom-mcp/asset-meta');
  });

  it('refuses the whole bundle on a naming error, and writes nothing', async () => {
    // A style problem is a *warning* and still writes; a reserved device name is an
    // *error* and does not. One direction is not a threshold, so both are here.
    const dir = await tempDir();
    const warned = await run(dir, 'Hero_Idle');
    expect(warned.written).toBe(true);
    expect(warned.naming.diagnostics.some((d) => d.severity === 'warning')).toBe(true);

    // A fresh directory, so "nothing was written" cannot be confused with the file the
    // warning case above deliberately left behind.
    const refuseDir = await tempDir();
    const refused = await run(refuseDir, 'hero', undefined, [{ path: 'hero/nul.png', role: 'frame' }]);
    expect(refused.written).toBe(false);
    expect(refused.files).toEqual([]);
    expect(refused.naming.ok).toBe(false);
    expect(refused.naming.diagnostics.some((d) => d.code === 'reserved-name')).toBe(true);
    expect(refused.refusal).toContain('reserved-name');
    expect(listFiles(refuseDir)).toEqual([]);
  });

  it('refuses two bundle paths that differ only in case', async () => {
    // One file on Linux, one on Windows, and the symptom surfaces in CI minutes from
    // its cause. The other error path through the same gate.
    const dir = await tempDir();
    const refused = await run(dir, 'hero', undefined, [
      { path: 'hero/Frame.png', role: 'frame' },
      { path: 'hero/frame.png', role: 'frame' },
    ]);
    expect(refused.written).toBe(false);
    expect(refused.naming.diagnostics.some((d) => d.code === 'case-collision')).toBe(true);
    expect(listFiles(dir)).toEqual([]);
  });

  it('an engine export carries the contract with it', async () => {
    // Every importer reads a contract, so `exportEngine` writing only `.tres` files
    // would hand the caller something they cannot re-derive.
    const dir = await tempDir();
    const result = await run(dir, 'hero', 'godot');
    expect(result.written).toBe(true);
    expect(result.files).toContain('meta.json');
    expect(result.engine?.engine).toBe('godot');
    expect(result.engine?.root).toBe('hero');
    expect(result.engine!.files.length).toBeGreaterThan(0);
    // The engine paths are relative to the *contract*, which lives in its own folder,
    // so on disk they sit one level below it: `<contract folder>/<root>/<file>`.
    const onDisk = listFiles(dir);
    for (const file of result.engine!.files) {
      expect(onDisk, file).toContain(`hero/${file}`);
    }
  });

  it('returns named defects and paths, and no score', async () => {
    const dir = await tempDir();
    const result = await run(dir, 'hero', 'phaser');
    expect(result.engine?.warnings.every((w) => typeof w === 'string')).toBe(true);
    expect(result.files.every((f) => typeof f === 'string')).toBe(true);
    // A score is a target. `quality_report` was deleted in 0.3.1 for exactly this:
    // a model handed the number sanded a lake into a dark flat rectangle.
    expect(Object.keys(result)).not.toContain('score');
    expect(Object.keys(result)).not.toContain('quality');
  });
});

function run(
  dir: string,
  name: string,
  engine?: AssetEngine,
  outputs?: { path: string; role: 'frame' | 'source' | 'gif' }[],
): Promise<AssetExportResult> {
  return exportAssetBundle(
    createSprite({ width: 8, height: 8, name, frames: 2, frameDurationMs: 100 }),
    {
      path: path.join(dir, name, 'meta.json'),
      ...(engine ? { engine } : {}),
      ...(outputs ? { outputs } : {}),
    },
  );
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'dotloom-asset-'));
}

/** Forward-slashed relative paths under `dir`, sorted, so no assertion is order-dependent. */
function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, next));
    else out.push(next);
  }
  return out.sort();
}

function read(root: string, rel: string): string {
  return readFileSync(path.join(root, rel), 'utf8');
}