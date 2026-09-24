/**
 * Tiny dependency-free argument parser.
 *
 * Supports `--key value`, `--key=value`, boolean `--flag`, short `-f` flags and
 * a trailing `--` terminator. The first positional is treated as the command.
 */

export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  /** A flag given more than once becomes an array, newest last. */
  flags: Record<string, string | boolean | string[]>;
}

/**
 * Record a flag, keeping every occurrence. A repeated flag (e.g. `--plugin a
 * --plugin b`) accumulates into an array instead of the last one winning.
 */
function pushFlag(flags: ParsedArgs['flags'], key: string, value: string | boolean): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    flags[key] = [String(existing), String(value)];
  }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: ParsedArgs['flags'] = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        pushFlag(flags, arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          pushFlag(flags, key, next);
          i++;
        } else {
          pushFlag(flags, key, true);
        }
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      pushFlag(flags, arg.slice(1), true);
      continue;
    }

    positionals.push(arg);
  }

  const command = positionals.shift() ?? null;
  return { command, positionals, flags };
}

/** The last value of a flag, if any. */
export function stringFlag(flags: ParsedArgs['flags'], key: string): string | undefined {
  const value = flags[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[value.length - 1];
  return undefined;
}

/** Every value of a repeatable flag, in order. */
export function repeatFlag(flags: ParsedArgs['flags'], key: string): string[] {
  const value = flags[key];
  if (value === undefined || value === false) return [];
  if (Array.isArray(value)) return value;
  if (value === true) return [''];
  return [value];
}

export function boolFlag(flags: ParsedArgs['flags'], key: string): boolean {
  const value = flags[key];
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return raw === true || raw === 'true' || raw === '1' || raw === '';
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
