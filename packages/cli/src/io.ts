import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deserializeSprite, serializeSprite, type Sprite } from '@pixel/core';
import { UsageError } from './args.js';

export async function readBytes(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw new UsageError(`cannot read "${path}": ${(error as Error).message}`);
  }
}

export async function writeBytes(path: string, data: Uint8Array): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}

export async function readText(path: string): Promise<string> {
  return new TextDecoder().decode(await readBytes(path));
}

export async function writeText(path: string, text: string): Promise<void> {
  await writeBytes(path, new TextEncoder().encode(text));
}

export async function loadSprite(path: string): Promise<Sprite> {
  const bytes = await readBytes(path);
  try {
    return deserializeSprite(bytes);
  } catch (error) {
    throw new UsageError(`"${path}" is not a readable .pixel file: ${(error as Error).message}`);
  }
}

export async function saveSprite(path: string, sprite: Sprite): Promise<void> {
  await writeBytes(path, serializeSprite(sprite));
}

/** Prints machine-readable JSON so agents can consume CLI output directly. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
