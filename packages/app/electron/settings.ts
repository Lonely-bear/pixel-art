/**
 * The main process's own preferences file.
 *
 * Appearance lives in the renderer's localStorage (`src/prefs.tsx`) and stays
 * there, because only the window needs it. Update preferences cannot: the
 * updater has to know whether to check *before* a window exists, and the
 * background schedule is set up during `start()`. So the two halves of the
 * settings live on the side that needs them first, and the renderer reads this
 * one over IPC like everything else.
 *
 * `userData/settings.json`, written atomically. The parsing is in
 * `update-settings.ts` so it can be tested without an Electron around it.
 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { UpdateSettings } from '../shared/types.js';
import { DEFAULT_UPDATE_SETTINGS, parseUpdateSettings } from './update-settings.js';

const FILE = 'settings.json';

export { DEFAULT_UPDATE_SETTINGS };

let cached: UpdateSettings | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), FILE);
}

export function readUpdateSettings(): UpdateSettings {
  if (cached) return cached;
  // Synchronous on purpose. This is called from `start()` before the first
  // window, and an unread preferences file must not delay the window by a tick.
  try {
    cached = parseUpdateSettings(readFileSync(filePath(), 'utf8'));
  } catch {
    // A first run has no file, and a missing file is not a problem.
    cached = { ...DEFAULT_UPDATE_SETTINGS };
  }
  return cached;
}

/**
 * Write through a temporary file and rename over the target.
 *
 * The updater writes on every check, and a machine that loses power mid-write
 * should come back with its preferences rather than a file that parses to
 * nothing.
 */
export async function writeUpdateSettings(next: UpdateSettings): Promise<void> {
  cached = next;
  const target = filePath();
  const temp = `${target}.tmp`;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
    await rename(temp, target);
  } catch (error) {
    console.error('[dotloom-mcp] could not save update settings:', error);
  }
}
