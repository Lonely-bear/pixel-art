import { toJSONSchema } from 'zod';
import type { Sprite } from '../document.js';
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
  /** Long-form manual, when the command has one. Read on demand, never in the tool list. */
  guide?: string;
  /** True when executing the command cannot mutate the document or its history. */
  readOnly?: boolean;
  /** JSON Schema (draft 2020-12) describing the command's parameters. */
  params: Record<string, unknown>;
}

export function describeCommand(command: Command): CommandDescription {
  return {
    name: command.name,
    description: command.description,
    ...(command.guide ? { guide: command.guide } : {}),
    readOnly: command.readOnly === true,
    params: toJSONSchema(command.params) as unknown as Record<string, unknown>,
  };
}

export function describeCommands(commands: readonly Command[]): CommandDescription[] {
  return commands.map(describeCommand);
}

/**
 * Names of parameters which the command's own schema requires.
 *
 * The generated MCP tool intentionally relaxes `layer` and `frame` to optional
 * arguments and fills them in at the edge.  Scripts and batch operations need the
 * exact same rule; deriving it from the schema here keeps those paths from growing
 * subtly different defaulting implementations.
 */
export function requiredCommandArgs(command: Command): Set<string> {
  const schema = toJSONSchema(command.params) as { required?: string[] };
  return new Set(schema.required ?? []);
}

/**
 * Apply the editor-wide defaults used by the MCP tool surface to command params.
 *
 * Only fields that are genuinely required by the command are filled.  An optional
 * `layer`/`frame` on a transform is a filter, and must not silently turn into the
 * bottom layer/frame zero.
 */
export function fillCommandDefaults(
  sprite: Sprite,
  command: Command,
  params: unknown,
): Record<string, unknown> {
  const filled =
    params && typeof params === 'object' && !Array.isArray(params)
      ? { ...(params as Record<string, unknown>) }
      : {};
  const required = requiredCommandArgs(command);
  if (required.has('layer') && filled.layer === undefined && sprite.layers[0]) {
    filled.layer = sprite.layers[0].id;
  }
  if (required.has('frame') && filled.frame === undefined && sprite.frames.length > 0) {
    filled.frame = 0;
  }
  return filled;
}
