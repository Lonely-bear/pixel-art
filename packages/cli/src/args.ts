/**
 * Tiny dependency-free argument parser.
 *
 * Supports `--key value`, `--key=value`, boolean `--flag`, short `-f` flags and
 * a trailing `--` terminator. The first positional is treated as the command.
 */

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
      continue;
    }

    positionals.push(arg);
  }

  const command = positionals.shift() ?? null;
  return { command, positionals, flags };
}

export function stringFlag(flags: ParsedArgs['flags'], key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

export function boolFlag(flags: ParsedArgs['flags'], key: string): boolean {
  const value = flags[key];
  return value === true || value === 'true' || value === '1' || value === '';
}

export function numberFlag(
  flags: ParsedArgs['flags'],
  key: string,
  fallback?: number,
): number | undefined {
  const raw = stringFlag(flags, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${key} expects a number, got "${raw}"`);
  return value;
}

export function intFlag(
  flags: ParsedArgs['flags'],
  key: string,
  fallback?: number,
): number | undefined {
  const value = numberFlag(flags, key, fallback);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new UsageError(`--${key} expects an integer, got "${value}"`);
  return value;
}

export function listFlag(flags: ParsedArgs['flags'], key: string): string[] | undefined {
  const raw = stringFlag(flags, key);
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Raised for bad user input; the CLI prints the message without a stack trace. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}
