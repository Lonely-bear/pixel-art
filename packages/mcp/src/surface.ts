/**
 * The advertised tool surface.
 *
 * The zod schemas in `tools.ts` are the single source of truth for *validation*, and
 * that is exactly what they are good at. Converted mechanically into a declaration they
 * are mediocre, for three measured reasons:
 *
 *  - **Safe-integer noise.** Every `z.number().int()` becomes
 *    `"minimum":-9007199254740991,"maximum":9007199254740991`. 521 occurrences across
 *    the surface, 28.7KB, carrying no information a model can act on.
 *  - **One convention restated per tool.** `document` and `expectedVersion` appear on
 *    all 127 tools, are optional on all 127, and are needed on none. 37.6KB to say
 *    "operate on the active document".
 *  - **No risk channel.** Annotations are what a client uses to decide whether to ask
 *    for confirmation and whether a tool is safe to retry. A declaration that omits
 *    them is not "safe by default", it is undeclared.
 *
 * So validation and declaration are separated on purpose: schemas stay strict and
 * complete, and this module produces the *advertised* form at `tools/list` time. One
 * place to diet every tool, instead of 127 hand-maintained exceptions - and a single
 * choke point that a test can assert against.
 *
 * What it deliberately does **not** do: invent descriptions, reorder properties, or
 * drop `additionalProperties: false`. Those are the author's decisions.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** `Number.MIN_SAFE_INTEGER`, the bound zod emits for a bare `z.number().int()`. */
const SAFE_MIN = -9007199254740991;
/** `Number.MAX_SAFE_INTEGER`, likewise. */
const SAFE_MAX = 9007199254740991;

/**
 * Targeting arguments every tool accepts, and no tool needs to advertise.
 *
 * They are optional everywhere and absent from most calls, so per-tool schemas spent
 * 9.4K tokens restating them. They stay in the zod shape - a model that read them in
 * the server instructions and passes one must not get a validation error - and
 * `SERVER_INSTRUCTIONS` is where they are documented instead.
 */
export const IMPLICIT_PROPERTIES = ['document', 'expectedVersion'] as const;

type JsonObject = Record<string, unknown>;

/**
 * The result envelope every tool validates against.
 *
 * `ok()`/`fail()` in `tools.ts` are the only two places a `CallToolResult` is built,
 * so one loose envelope describes all of them. It is deliberately permissive: a tool
 * that returns `{ok, command, version, summary, results, files, ...}` conforms, and the
 * fields worth branching on are named.
 *
 * The descriptions are kept short on purpose. This schema is repeated on every tool in
 * the list, so a word here is paid for once per tool; the long-form explanation of the
 * concurrency and failure conventions lives once in `SERVER_INSTRUCTIONS`, where it is
 * read a single time.
 */
export const TOOL_RESULT_ENVELOPE = z.looseObject({
  ok: z.boolean().optional().describe('True on success.'),
  version: z.number().int().optional().describe('Document version after this call; send it back as `expectedVersion`.'),
  summary: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    .describe('What changed, in the tool\'s own terms.'),
  error: z.string().optional().describe('Why it failed. Only on a failed result.'),
  code: z.string().optional().describe('Stable failure code to branch on, e.g. version_conflict, invalid_op, unknown_command.'),
  remediation: z.string().optional().describe('The specific change that fixes the call, when there is one.'),
});

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `anyOf`/`oneOf` branch lists, the only composite keywords the emitted schema uses. */
const BRANCH_KEYS = ['anyOf', 'oneOf', 'allOf'] as const;

/**
 * Drop the bounds zod emits for every integer.
 *
 * A `maximum` of 2^53-1 does not stop a model from passing a pixel coordinate, and
 * carrying 55 characters of it 521 times is 28.7KB of the tool list. Real bounds -
 * `max(4096)`, `min(0)`, `max(1)` on an opacity - are untouched, because they are
 * hand-written and mean something.
 */
function stripSafeIntBounds(node: JsonObject): void {
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    const value = node[key];
    if (value === SAFE_MIN || value === SAFE_MAX) delete node[key];
  }
  // `$schema` and an empty `additionalProperties` are both emitted on every schema and
  // mean nothing at this level: the dialect is fixed by the MCP spec, and an empty
  // object is how a loose (passthrough) object is spelled.
  delete node.$schema;
  if (isObject(node.additionalProperties) && Object.keys(node.additionalProperties).length === 0) {
    delete node.additionalProperties;
  }
}

/**
 * A one-branch union is the schema writer saying the same thing twice.
 *
 * `z.union([z.string()])` and friends arrive here as `anyOf: [{...}]`; inlining the
 * branch keeps the description and drops a level of nesting the model has to read
 * through.
 */
function collapseSingleBranchUnion(node: JsonObject): boolean {
  for (const key of BRANCH_KEYS) {
    const branches = node[key];
    if (!Array.isArray(branches) || branches.length !== 1 || !isObject(branches[0])) continue;
    const branch = branches[0];
    delete node[key];
    // The branch's own keywords win; the wrapper's prose is the only thing it adds.
    for (const [k, v] of Object.entries(branch)) {
      if (k === 'description' && typeof node.description === 'string') continue;
      node[k] = v;
    }
  }
  return true;
}

/**
 * Strip the zod-to-JSON-Schema noise out of one advertised schema.
 *
 * @param schema  the schema as the SDK generated it
 * @param root    when true, also drop {@link IMPLICIT_PROPERTIES}
 */
function diet(schema: unknown, root = false): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => diet(entry));
  if (!isObject(schema)) return schema;

  stripSafeIntBounds(schema);
  collapseSingleBranchUnion(schema);

  for (const key of BRANCH_KEYS) {
    const branches = schema[key];
    if (Array.isArray(branches)) schema[key] = branches.map((entry) => diet(entry));
  }
  if (schema.items !== undefined) schema.items = diet(schema.items);
  if (isObject(schema.$defs)) {
    const defs: JsonObject = {};
    for (const [name, def] of Object.entries(schema.$defs)) defs[name] = diet(def);
    schema.$defs = defs;
  }
  if (root && isObject(schema.properties)) {
    const properties: JsonObject = {};
    for (const [name, property] of Object.entries(schema.properties)) {
      if (!(IMPLICIT_PROPERTIES as readonly string[]).includes(name)) properties[name] = property;
    }
    schema.properties = properties;
    const required = schema.required;
    if (Array.isArray(required)) {
      const kept = required.filter((name: unknown) => !(IMPLICIT_PROPERTIES as readonly string[]).includes(name as string));
      if (kept.length === 0) delete schema.required;
      else schema.required = kept;
    }
  }
  if (isObject(schema.properties)) {
    const properties: JsonObject = {};
    for (const [name, property] of Object.entries(schema.properties)) properties[name] = diet(property);
    schema.properties = properties;
  }
  return schema;
}

/**
 * Install the advertised-surface pass in front of the SDK's own `tools/list` handler.
 *
 * `McpServer` owns that handler and refuses to have it replaced, so this wraps the
 * instance's `setRequestHandler` before the first `registerTool` installs it. Only the
 * *list* is transformed: `tools/call` still validates arguments against the untouched
 * zod schema, which is the whole point - the declaration gets leaner, the contract
 * stays strict.
 */
export function installToolSurface(server: McpServer): void {
  const low = server.server;
  const original = low.setRequestHandler.bind(low);
  low.setRequestHandler = ((schema: unknown, handler: unknown) => {
    if (schema !== ListToolsRequestSchema) {
      return (original as (s: unknown, h: unknown) => unknown)(schema, handler);
    }
    const list = handler as (request: unknown, extra: unknown) => { tools?: Tool[] } | Promise<{ tools?: Tool[] }>;
    const transform = (result: { tools?: Tool[] }) => ({
      ...result,
      tools: (result.tools ?? []).map((tool) => advertise(tool)),
    });
    // The SDK's handler is synchronous today; awaiting a possibly-sync result keeps
    // this working if it stops being so.
    const wrapped = (request: unknown, extra: unknown) =>
      Promise.resolve(list(request, extra)).then(transform);
    return (original as (s: unknown, h: unknown) => unknown)(schema, wrapped);
  }) as typeof low.setRequestHandler;
}

function advertise(tool: Tool): Tool {
  const next: Tool = { ...tool };
  if (next.inputSchema !== undefined) next.inputSchema = diet(next.inputSchema, true) as Tool['inputSchema'];
  if (next.outputSchema !== undefined) next.outputSchema = diet(next.outputSchema) as Tool['outputSchema'];
  return next;
}

/** Bytes an advertised schema would save, used by the surface test to keep it honest. */
export function measureDiet(schema: unknown): { before: number; after: number } {
  const clone = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const before = JSON.stringify(schema).length;
  const after = JSON.stringify(diet(clone(schema), true)).length;
  return { before, after };
}

/**
 * The same form `tools/list` advertises, for a schema held anywhere else.
 *
 * `describe_command` uses this so that when it describes one of the entry-point tools
 * it returns what the client would have seen anyway - safe-integer bounds and the
 * implicit targeting arguments stripped - rather than a second, noisier dialect.
 */
export function advertiseSchema(schema: unknown): unknown {
  return diet(JSON.parse(JSON.stringify(schema)), true);
}
