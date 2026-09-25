import { z } from 'zod';
import type { Command, CommandContext, CommandSummary } from './types.js';
import {
  colorSchema,
  frameRefSchema,
  layerRefSchema,
  pointSchema,
  rectSchema,
} from './types.js';

/**
 * Plugin commands.
 *
 * A plugin is a script (see `@pixel/script`) that calls `defineCommand(...)` to add a
 * new command to the bus. Everything a client needs to describe such a command — its
 * name, description and parameter schema — is declared *as data*, so the same command
 * shows up correctly in the MCP tool list, the CLI catalogue and the UI without any of
 * them knowing what a plugin is.
 *
 * The parameter spec is a deliberately tiny DSL rather than raw zod: plugin authors
 * write JavaScript in a sandbox, where zod is not available, and a JSON-serialisable
 * spec is also what an agent can emit directly.
 */

export type PluginParamType =
  | 'number'
  | 'int'
  | 'boolean'
  | 'string'
  | 'color'
  | 'layer'
  | 'frame'
  | 'rect'
  | 'point'
  | 'json';

export interface PluginParamSpec {
  type: PluginParamType;
  /** Defaults to `false` (the parameter is optional) unless set to `true`. */
  required?: boolean;
  default?: unknown;
  description?: string;
  /** Inclusive bounds for `number`/`int`. */
  min?: number;
  max?: number;
  /** Restricts a `string` to these exact values (an enum). */
  values?: readonly string[];
}

export type PluginParamsSpec = Record<string, PluginParamSpec>;

export interface PluginCommandDefinition {
  name: string;
  description?: string;
  readOnly?: boolean;
  params?: PluginParamsSpec;
}

/** Command names are lowercase snake case, 2-64 characters. */
export const PLUGIN_COMMAND_NAME = /^[a-z][a-z0-9_]{1,63}$/;

function paramSchema(spec: PluginParamSpec): z.ZodType {
  let schema: z.ZodType;
  switch (spec.type) {
    case 'number':
      schema = z.number();
      break;
    case 'int':
      schema = z.number().int();
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'string':
      schema = spec.values && spec.values.length ? z.enum(spec.values as [string, ...string[]]) : z.string();
      break;
    case 'color':
      schema = colorSchema;
      break;
    case 'layer':
      schema = layerRefSchema;
      break;
    case 'frame':
      schema = frameRefSchema;
      break;
    case 'rect':
      schema = rectSchema;
      break;
    case 'point':
      schema = pointSchema;
      break;
    case 'json':
      schema = z.unknown();
      break;
    default:
      throw new Error(`Unknown plugin parameter type: ${String((spec as { type?: unknown }).type)}`);
  }

  if (spec.type === 'number' || spec.type === 'int') {
    if (typeof spec.min === 'number') schema = (schema as z.ZodNumber).min(spec.min);
    if (typeof spec.max === 'number') schema = (schema as z.ZodNumber).max(spec.max);
  }
  if (spec.description) schema = schema.describe(spec.description);

  // Parameters are optional unless explicitly required; a `default` also implies
  // optionality, since the schema itself can supply the value.
  if (spec.default !== undefined) return schema.default(spec.default as never);
  return spec.required === true ? schema : schema.optional();
}

/**
 * Turn a plugin's declarative parameter spec into the strict zod schema the command
 * bus validates against. Strict at the top level for the same reason built-in
 * commands are: a mistyped argument must be an error, not a silent default.
 */
export function buildParamsSchema(spec: PluginParamsSpec = {}): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, param] of Object.entries(spec)) {
    shape[name] = paramSchema(param);
  }
  return z.object(shape).strict();
}

/**
 * Build a `Command` from a plugin's declarative definition and the sandboxed function
 * that implements it. The returned object is indistinguishable from a built-in command
 * to the registry, the editor and every discovery surface.
 */
export function createPluginCommand(
  def: PluginCommandDefinition,
  apply: (ctx: CommandContext, params: Record<string, unknown>) => CommandSummary | void,
): Command {
  if (typeof def?.name !== 'string' || !PLUGIN_COMMAND_NAME.test(def.name)) {
    throw new Error(
      `Invalid plugin command name: ${JSON.stringify(def?.name)}. Use lowercase snake case, e.g. "draw_star".`,
    );
  }
  if (def.readOnly !== undefined && typeof def.readOnly !== 'boolean') {
    throw new Error(`Plugin command ${def.name} has a non-boolean readOnly value.`);
  }
  return {
    name: def.name,
    description: def.description ?? '',
    params: buildParamsSchema(def.params),
    readOnly: def.readOnly,
    apply: apply as Command['apply'],
  };
}
