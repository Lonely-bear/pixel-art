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
 * Two keywords zod emits that constrain nothing.
 *
 * `propertyNames: {type: "string"}` comes from every `z.record(z.string(), …)`. JSON
 * object keys *are* strings - there is no document in which a key is anything else -
 * so the keyword is a restatement of the format, not a constraint, and it is emitted
 * 33 times across the list. `properties: {}` comes from a loose object with no declared
 * members, which is how "anything" is spelled; the emptiness says nothing.
 *
 * Both are removed on the advertisement only. They never reach `tools/call`, which
 * validates against the untouched zod schema, and neither was ever able to reject an
 * input - which is the test for whether a keyword is information or decoration.
 */
function stripVacuousKeywords(node: JsonObject): void {
  const names = node.propertyNames;
  if (isObject(names) && Object.keys(names).length === 1 && names.type === 'string') {
    delete node.propertyNames;
  }
  if (isObject(node.properties) && Object.keys(node.properties).length === 0) {
    delete node.properties;
  }
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
  stripVacuousKeywords(schema);
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
 * A sentence end that really ends a sentence.
 *
 * A naive scan for `[.!?]` truncates `"Tint earlier ghosts (e.g. \"#ff8080\") ..."`
 * to `"Tint earlier ghosts (e.g."`, because the full stop in `e.g.` is followed by a
 * space. So a boundary only counts when what follows is a capital, a backtick, or the
 * end of the string - which is also the only case where the tail is prose this
 * function was entitled to drop.
 */
const SENTENCE_END = /[.!?](?=\s)/g;

function isSentenceBoundary(text: string, index: number): boolean {
  const next = text.slice(index + 1).trimStart();
  if (next === '') return true;
  return /[A-Z`]/.test(next[0]);
}

/**
 * The shortest description worth truncating to.
 *
 * `"ok."` is not a shorter description, it is a worse one, so a head shorter than this
 * is left alone and the whole text stands. 32 is the length below which the surviving
 * sentence has, in practice, lost its subject - measured over this repository's own
 * `.describe()` text, every shorter head was a fragment.
 */
const MIN_HEAD = 32;

/**
 * The shortest a tool's advertised description is allowed to be.
 *
 * Distinct from {@link MIN_HEAD}, and deliberately larger. A parameter description of
 * 40 characters is a usable label next to its own name; a *tool* description is all
 * the discovery signal there is, and below this the tool stops being findable by what
 * it does. 80 is the floor the surface test has always held descriptions to, so a
 * tool that cannot beat it keeps its whole text.
 */
const MIN_HEADLINE = 80;

/**
 * The first sentence of a description, or the whole thing when there is nothing safe
 * to drop.
 *
 * Every `.describe()` in this repository is written as a sentence first and a
 * qualification second, and that is the order an agent reads in: what the parameter
 * *is*, then when the caveat applies. Truncating to the first sentence keeps the part
 * that decides whether to pass the argument and drops the part needed only once the
 * value is being spelled out - and that part is relocated, not deleted:
 * `describe_command` returns the untruncated schema (see {@link fullSchema}).
 *
 * This is applied to *input* schemas only. An output schema is read at a different
 * moment, by a caller that already has the result in front of it and is asking "what
 * does this field mean", and the envelope's qualifiers are exactly that answer.
 */
export function firstSentence(description: string): string {
  SENTENCE_END.lastIndex = 0;
  for (let match = SENTENCE_END.exec(description); match; match = SENTENCE_END.exec(description)) {
    const index = match.index;
    if (!isSentenceBoundary(description, index)) continue;
    const head = description.slice(0, index + 1).trim();
    if (head.length < MIN_HEAD) continue;
    return head;
  }
  return description;
}

function summarizeDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(summarizeDescriptions);
  if (!isObject(node)) return node;
  for (const key of Object.keys(node)) {
    if (key === 'description' && typeof node.description === 'string') {
      node.description = firstSentence(node.description);
    } else {
      node[key] = summarizeDescriptions(node[key]);
    }
  }
  return node;
}

function stripDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (!isObject(node)) return node;
  const next: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description') continue;
    next[key] = stripDescriptions(value);
  }
  return next;
}

/**
 * The advertised form of {@link TOOL_RESULT_ENVELOPE}: six field names, their types,
 * no prose.
 *
 * Thirty-six tools repeat this object byte for byte, so in an agent's context the same
 * paragraph is read thirty-six times for one result. What a caller reads off a
 * *particular* call is the shape - `ok` to branch on success, `code` to branch on the
 * failure, `version` to send back - and the shape is all this is. The conventions the
 * prose explains are not deleted: they are in `SERVER_INSTRUCTIONS`, read once per
 * session, and `describe_command` returns the envelope with its descriptions intact as
 * `resultSchema`, for a caller that wants the qualified version of a field.
 *
 * A `$ref` into a shared `$defs` was considered and rejected. MCP has no document a
 * tool's schema could point into, so a cross-tool `$ref` resolves for a client holding
 * the entire `tools/list` response and for nothing else - which is a broken promise to
 * the client that reads one tool's schema in isolation, and the common case. A
 * within-document `$defs` does resolve, but the repeated subtrees left *inside* a
 * single tool's schema total ~700 bytes across the whole list, which does not pay for
 * the indirection.
 *
 * Emitted through the SDK's own `z.toJSONSchema` rather than written out by hand,
 * because a field added to {@link TOOL_RESULT_ENVELOPE} has to appear here by
 * construction: two hand-maintained spellings of one contract is how a contract
 * drifts, and this module exists to stop the declaration drifting from the validation.
 */
const ADVERTISED_ENVELOPE = stripDescriptions(
  diet(z.toJSONSchema(TOOL_RESULT_ENVELOPE, { io: 'output' })),
);
const ADVERTISED_ENVELOPE_KEY = JSON.stringify(ADVERTISED_ENVELOPE);

/** The `execution` block the SDK writes on every tool it registers. */
const DEFAULT_EXECUTION = { taskSupport: 'forbidden' } as const;

/**
 * The same schema with every description left at full length.
 *
 * `describe_command` uses this rather than {@link advertiseSchema}, because the diet's
 * one-sentence summaries are a *listing* economy: they answer "may I pass this?" and
 * defer "and when?". A caller that has decided to pass the argument and is spelling
 * the value out is asking the second question, and it should get the whole answer.
 */
export function fullSchema(schema: unknown): unknown {
  return diet(JSON.parse(JSON.stringify(schema)), true);
}

/**
 * A `pixel://` reference anywhere in the text, so it can be carried across.
 *
 * These are the difference between a caveat and a route. A dropped caveat is still
 * one `describe_command` away; a dropped `pixel://guide/{command}` is a pointer to a
 * manual the agent was never told exists, and the sentence it usually sits in is the
 * second one. Truncating that sentence silently removed the only mention of
 * `autotile`'s guide from its own tool listing - which is how a manual becomes
 * unreachable without anything looking broken.
 */
const RESOURCE_URI = /pixel:\/\/[^\s`,)]+/g;

/**
 * The `pixel://` references in a piece of text, without the punctuation that ends the
 * sentence they sit in.
 *
 * The trailing full stop is the whole subtlety. `…see pixel://quality/{doc}.` matches
 * a naive scan as `pixel://quality/{doc}.`, and carrying *that* forward re-emits the
 * reference as `pixel://quality/{doc}..` - a URI that resolves to nothing, which is a
 * worse outcome than the one the trimming was meant to avoid.
 */
function resourceUris(text: string): string[] {
  return (text.match(RESOURCE_URI) ?? []).map((uri) => uri.replace(/[.,;:]+$/, ''));
}

/**
 * A description reduced to its first sentence, keeping every resource reference.
 *
 * Appends the references the first sentence did not already carry, so the advertised
 * text is a strict subset of the original in *content* and a superset in *routes*.
 */
export function headline(description: string): string {
  const head = firstSentence(description);
  if (head === description) return head;
  const carried = new Set(resourceUris(head));
  const dropped = resourceUris(description).filter((uri) => !carried.has(uri));
  if (dropped.length === 0) return head;
  return `${head} See ${dropped.join(', ')}.`;
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
  if (typeof next.description === 'string') {
    // A tool description is two things at once - what the tool is, and how to use it -
    // and in a list only the first is read. `describe_command` returns a session tool's
    // text in full, which is where the second half belongs: it is consulted once, by a
    // caller who has already picked the tool. Resource references are carried across,
    // because a pointer to a manual is not a caveat.
    //
    // Session tools only. A command's description is prose *plus* a machine-facing
    // sentence appended by core - "Undoable as one step", the cost of calling it - and
    // that sentence is the part a promoted tool is promoted for. Truncating it away
    // was caught by `server.test.ts`, which is the suite doing its job: the listing
    // lost the one fact that says whether the command is cheap to run.
    const isSessionTool = isObject(next._meta) && next._meta.kind === 'session';
    const first = isSessionTool ? headline(next.description) : next.description;
    // Only when the headline is still a description. A tool announced in 60 characters
    // is not discoverable, and no saving is worth trading the list's one job away.
    if (isSessionTool && first.length >= MIN_HEADLINE) next.description = first;
  }
  if (next.inputSchema !== undefined) {
    next.inputSchema = summarizeDescriptions(diet(next.inputSchema, true)) as Tool['inputSchema'];
  }
  if (next.outputSchema !== undefined) {
    const output = diet(next.outputSchema) as Tool['outputSchema'];
    // The shared envelope, 36 times over, replaced by its shape. Every other
    // outputSchema - `evaluate`'s quality report is the only one today - is left with
    // its descriptions, because a bespoke result is described per field for a reason.
    next.outputSchema = (
      JSON.stringify(stripDescriptions(output)) === ADVERTISED_ENVELOPE_KEY
        ? ADVERTISED_ENVELOPE
        : output
    ) as Tool['outputSchema'];
  }
  // The SDK stamps `execution: {taskSupport: "forbidden"}` on every tool it registers,
  // and the MCP specification says an absent `execution` *means* forbidden. 999 bytes
  // of the tool list to restate a default the client already applies - and unlike the
  // four risk hints, which default to "unknown" and so are genuinely undeclared
  // without them, this one carries no information the client does not already have.
  if (isObject(next.execution) && next.execution.taskSupport === DEFAULT_EXECUTION.taskSupport) {
    delete next.execution;
  }
  return next;
}

/**
 * Bytes the advertised form saves on a schema, so the surface test can hold the diet
 * to a number instead of to a list of intentions.
 *
 * This is the *input* dialect, because that is where the diet acts: safe-integer
 * bounds, the implicit targeting arguments, and the one-sentence summaries.
 */
export function measureDiet(schema: unknown): { before: number; after: number } {
  const clone = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const before = JSON.stringify(schema).length;
  const after = JSON.stringify(summarizeDescriptions(diet(clone(schema), true))).length;
  return { before, after };
}

