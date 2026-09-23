import { toJSONSchema } from 'zod';
import type { Command } from './types.js';

/**
 * Machine-readable description of a command: exactly the shape an MCP tool needs.
 *
 * The `params` JSON Schema is generated from the command's zod schema, so tool
 * documentation can never drift from the validation the command actually performs.
 */
export interface CommandDescription {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12) describing the command's parameters. */
  params: Record<string, unknown>;
}

export function describeCommand(command: Command): CommandDescription {
  return {
    name: command.name,
    description: command.description,
    params: toJSONSchema(command.params) as unknown as Record<string, unknown>,
  };
}

export function describeCommands(commands: readonly Command[]): CommandDescription[] {
  return commands.map(describeCommand);
}
