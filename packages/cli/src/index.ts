#!/usr/bin/env node
/**
 * `pixel` — the headless CLI for @pixel/core.
 *
 * Every command prints a single JSON object to stdout so it can be piped into other
 * tools and, later, wrapped one-for-one by the MCP server. Exit code 0 means success.
 */

import { parseArgs, UsageError } from './args.js';
import { COMMANDS, findCommand } from './commands.js';

const USAGE = `pixel — headless pixel art tooling

Usage: pixel <command> [options]

Commands:
${COMMANDS.map((command) => `  ${command.name.padEnd(10)} ${command.summary}`).join('\n')}

Run \`pixel <command> --help\` or \`pixel help <command>\` for details.
All commands print JSON to stdout; errors print JSON to stderr and exit non-zero.
`;

function fail(message: string, code = 1): number {
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  return code;
}

async function main(): Promise<number> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  if (command === null || command === 'help' || flags['help'] === true || flags['h'] === true) {
    const target = command === 'help' ? positionals[0] : command;
    const spec = target ? findCommand(target) : undefined;
    if (spec) {
      process.stdout.write(`${spec.name} — ${spec.summary}\n\nUsage: ${spec.usage}\n`);
    } else {
      process.stdout.write(USAGE);
    }
    return 0;
  }

  if (command === 'version' || flags['version'] === true) {
    process.stdout.write(`${JSON.stringify({ name: '@pixel/cli', version: '0.0.0' })}\n`);
    return 0;
  }

  const spec = findCommand(command);
  if (!spec) return fail(`unknown command "${command}"; run \`pixel help\``);

  try {
    return await spec.run({ args: { command, positionals, flags }, rest: positionals });
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message, 2);
    return fail((error as Error).message);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.exitCode = fail(`unexpected failure: ${(error as Error).message}`);
  },
);
