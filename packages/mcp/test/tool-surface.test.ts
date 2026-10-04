/**
 * The declared tool surface, held to a budget.
 *
 * Everything in this file is a regression guard for a decision that is invisible in
 * the diff. The tool list is 30-odd tools instead of 127 because the catalogue is
 * pulled on demand; schemas are stripped of safe-integer noise and of the two
 * arguments every tool accepts; every tool declares an output schema and all four
 * risk hints. All four of those are one careless edit away from silently undoing
 * ~55K tokens of prompt, so they are measured here rather than trusted.
 *
 * The sizes below are the *ceiling*, not the current value. When a tool genuinely
 * needs to grow, raise the number in the same commit and say why in the test name.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createPixelServer, type PixelServer } from '../src/server.js';
import { IMPLICIT_PROPERTIES } from '../src/surface.js';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? '{}');
}

/**
 * The tool allowed to run past the description budget.
 *
 * `read_grid` is the primary way to check a drawing, so it has to say when to reach
 * for it *instead* of a preview, and name the four views. Everything else about it -
 * regions, frames, layers, diffing - is in the schema, where it costs nothing unless
 * it is used.
 *
 * It is here because its headline is *under* the 80 characters the diet requires, so
 * it keeps its whole description rather than being cut to one. The three that used to
 * be here - `apply_ops`, `run_script`, `preview_tilemap` - are gone because the diet
 * gave them 124, 116 and 162 character headlines instead of 817, 957 and 565. Their
 * declared prose is unchanged and is still what `describe_command` returns; the
 * listing simply stopped restating it. Leaving the exemptions would have hidden a
 * regression, which is the one thing a budget list must not do.
 */
const DESCRIPTION_BUDGET: Record<string, number> = {
  read_grid: 1000,
};
const DESCRIPTION_FLOOR = 80;

let client: Client;
let pixel: PixelServer;

async function connect(options: Parameters<typeof createPixelServer>[0] = {}): Promise<{
  tools: Awaited<ReturnType<Client['listTools']>>['tools'];
}> {
  pixel = createPixelServer({ initialDocument: null, ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'surface-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), pixel.server.connect(serverTransport)]);
  return client.listTools();
}

afterEach(async () => {
  await client?.close();
  await pixel?.server.close();
});

describe('declared tool surface', () => {
  it('ships the entry points, not the whole catalogue, by default', async () => {
    const { tools } = await connect();
    const names = tools.map((t) => t.name);

    // The five ways in. Without any of these the small list would be a dead end.
    for (const entry of ['apply_ops', 'run_script', 'list_commands', 'describe_command', 'find_workflow']) {
      expect(names).toContain(entry);
    }
    // The perception and delivery tools an agent needs unprompted.
    for (const always of ['get_preview', 'preview_animation', 'finalize_document', 'get_document']) {
      expect(names).toContain(always);
    }
    // And the catalogue really is not in the list.
    expect(names).not.toContain('draw_rect');
    expect(names).not.toContain('autotile');
  });

  it('fits in 71KB because the prose was relocated, not deleted - that is what the next lane has to preserve', async () => {
    // 38 tools / 70,668 bytes measured through `tools/list`, down from 99,994 at six
    // bytes of headroom. The saving came from four relocations, each with a pull route
    // that the tests below check: the result envelope became a shape (its prose is in
    // the server instructions and in `describe_command`'s `resultSchema`), and tool
    // and parameter descriptions became their first sentence (the full text is what
    // `describe_command` returns). Nothing here is gone; it is one call away.
    //
    // The budget is what stops a new tool from quietly costing 4K tokens of every
    // request in every session, and it is deliberately set *at* the achieved number
    // rather than at a round target: a ceiling with headroom is an invitation.
    const { tools } = await connect();
    const bytes = tools.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t)), 0);
    expect(tools.length).toBeLessThanOrEqual(40);
    expect(bytes).toBeLessThanOrEqual(71_000);
  });

  it('declares all four risk hints on every tool', async () => {
    const { tools } = await connect();
    for (const tool of tools) {
      const annotations = tool.annotations ?? {};
      // Present, not merely sometimes-true: a missing hint is a client guessing.
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        expect(typeof annotations[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
    }
  });

  it('marks the two tools that execute caller code as open-world', async () => {
    const { tools } = await connect();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('run_script')?.annotations?.openWorldHint).toBe(true);
    expect(byName.get('load_plugin')?.annotations?.openWorldHint).toBe(true);
    expect(byName.get('get_preview')?.annotations?.openWorldHint).toBe(false);
    expect(byName.get('get_preview')?.annotations?.readOnlyHint).toBe(true);
  });

  it('declares an output schema on every tool', async () => {
    const { tools } = await connect();
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} has no outputSchema`).toBeTruthy();
      const properties = (tool.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties)).toContain('ok');
    }
  });

  it('keeps every parameter self-describing', async () => {
    const { tools } = await connect();
    // x/y/w/h inside a rect or point are conventional and the parent is described;
    // anything else without a description is a parameter a model has to guess at.
    const conventional = new Set(['x', 'y', 'w', 'h']);
    const undocumented: string[] = [];
    for (const tool of tools) {
      const walk = (node: unknown, path: string): void => {
        if (!node || typeof node !== 'object') return;
        const schema = node as { properties?: Record<string, { description?: string }> };
        for (const [key, property] of Object.entries(schema.properties ?? {})) {
          if (!property.description && !conventional.has(key)) undocumented.push(`${tool.name}.${path}${key}`);
          walk(property, `${path}${key}.`);
        }
      };
      walk(tool.inputSchema, '');
    }
    expect(undocumented).toEqual([]);
  });

  it('holds descriptions between the floor and the budget', async () => {
    const { tools } = await connect();
    for (const tool of tools) {
      const length = (tool.description ?? '').length;
      expect(length, `${tool.name} description is ${length} chars`).toBeGreaterThanOrEqual(DESCRIPTION_FLOOR);
      expect(length, `${tool.name} description is ${length} chars`).toBeLessThanOrEqual(
        DESCRIPTION_BUDGET[tool.name] ?? 500,
      );
    }
  });

  it('does not ship zod integer noise or restate the implicit arguments', async () => {
    const { tools } = await connect();
    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema);
      // 521 occurrences, 28.7KB, before the diet.
      expect(schema.includes('-9007199254740991'), `${tool.name} carries safe-integer noise`).toBe(false);
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const implicit of IMPLICIT_PROPERTIES) {
        // Accepted, but documented once in the server instructions instead of 127 times.
        expect(properties, `${tool.name} still advertises ${implicit}`).not.toHaveProperty(implicit);
      }
    }
  });

  it('still accepts the arguments it does not advertise', async () => {
    // The diet is on the advertisement only. `document` and `expectedVersion` stay in
    // the zod shape, so a model that read the server instructions and passed one gets
    // a real answer instead of a validation error - here, a genuine version conflict,
    // which is the only proof the argument was honoured rather than ignored.
    await connect();
    const created = payload((await client.callTool({
      name: 'create_document',
      arguments: { width: 8, height: 8, layers: ['base'] },
    })) as ToolResult);
    const document = created.document as { id: string; version: number };

    const ops = [{ command: 'draw_rect', rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#ff0000', fill: true }];
    const stale = (await client.callTool({
      name: 'apply_ops',
      arguments: { document: document.id, expectedVersion: document.version + 99, ops },
    })) as ToolResult;
    expect(stale.isError).toBe(true);
    expect(payload(stale).code).toBe('version_conflict');

    const fresh = (await client.callTool({
      name: 'apply_ops',
      arguments: { document: document.id, expectedVersion: document.version, ops },
    })) as ToolResult;
    expect(fresh.isError).toBeUndefined();
    expect(payload(fresh).applied).toBe(1);
  });

  it('advertises a schema that stands alone, because the diet is only allowed to make one smaller', async () => {
    // The single most dangerous way to spend these bytes is a `$ref`. MCP gives a tool
    // no document to point into, so a cross-tool `$ref` resolves for a client holding
    // the whole `tools/list` response and for nothing else - and the common client
    // reads one tool's schema at a time. The saving is real and the promise is not, so
    // this is asserted rather than trusted: zero `$ref` anywhere, and no `$defs`
    // entry that something in the same tool does not point at.
    const { tools } = await connect();
    const refs: string[] = [];
    const dangling: string[] = [];
    const walk = (node: unknown, tool: string): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return void node.forEach((entry) => walk(entry, tool));
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === '$ref') refs.push(`${tool}: ${String(value)}`);
        walk(value, tool);
      }
    };
    for (const tool of tools) {
      walk(tool.inputSchema, tool.name);
      walk(tool.outputSchema, tool.name);
      const defs = (tool.inputSchema as { $defs?: Record<string, unknown> })?.$defs ?? {};
      const serialised = JSON.stringify(tool.inputSchema);
      for (const name of Object.keys(defs)) {
        if (!serialised.includes(`"#/$defs/${name}"`)) dangling.push(`${tool.name}.$defs.${name}`);
      }
    }
    expect(refs).toEqual([]);
    expect(dangling).toEqual([]);
  });

  it('advertises the result envelope as a shape and still serves its prose on demand', async () => {
    // 23,345 bytes of the old list were one 667-byte paragraph repeated 36 times. The
    // shape is what a caller reads off a particular call; the conventions it explained
    // are not deleted, they are in the server instructions and in `resultSchema` here.
    // Both halves are asserted, because a diet that only checked the first would let
    // the second rot away unnoticed.
    const { tools } = await connect();
    const shared = tools.filter((tool) => tool.name !== 'evaluate');
    const key = JSON.stringify(shared[0].outputSchema);
    expect(shared.every((tool) => JSON.stringify(tool.outputSchema) === key)).toBe(true);
    // A shape: the field names a caller branches on, and no prose.
    expect(Object.keys((shared[0].outputSchema as { properties: object }).properties))
      .toEqual(['ok', 'version', 'summary', 'error', 'code', 'remediation']);
    expect(JSON.stringify(shared[0].outputSchema)).not.toContain('description');

    // A tool with its own result keeps its own schema - `evaluate`'s quality report is
    // described field by field, and that is not a duplication to be optimised away.
    const bespoke = tools.find((tool) => tool.name === 'evaluate')!;
    expect(JSON.stringify(bespoke.outputSchema)).toContain('"description"');

    await connect();
    const described = payload((await client.callTool({
      name: 'describe_command',
      arguments: { name: 'undo' },
    })) as ToolResult);
    const tool = described.tool as {
      resultSchema: { properties: Record<string, { description?: string }> };
    };
    // Every field named in the advertised shape is explained in the served one.
    for (const field of Object.keys((shared[0].outputSchema as { properties: object }).properties)) {
      expect(tool.resultSchema.properties[field]?.description, `resultSchema.${field}`).toBeTruthy();
    }
    expect(tool.resultSchema.properties.code?.description).toMatch(/branch on/i);
  });

  it('relocates description prose rather than rewriting it, and never drops a route', async () => {
    // The budget above is only defensible if the text it removed is still reachable,
    // so this is the test that makes the diet a relocation instead of a deletion: for
    // every tool, the advertised description is a prefix of the one `describe_command`
    // serves, and the advertised parameter descriptions are prefixes of theirs.
    //
    // The `pixel://` clause is here because it failed once, the day the diet landed.
    // `autotile`'s only mention of `pixel://guide/autotile` was in its second
    // sentence, so the truncation silently unpublished the manual - nothing looked
    // broken, and the manual simply became unreachable.
    const { tools } = await connect();
    await connect();
    const advertised = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of advertised.keys()) {
      const full = payload((await client.callTool({
        name: 'describe_command',
        arguments: { name },
      })) as ToolResult).tool as {
        description: string;
        params: { properties?: Record<string, { description?: string }> };
      };
      const listed = advertised.get(name)!;

      // Sentence punctuation is not part of a URI: `…see pixel://quality/{doc}.` refers to
      // `pixel://quality/{doc}`. Asserting the un-stripped form would pin the mistake
      // that the first version of `headline` made.
      const uris = (text: string): string[] =>
        (text.match(/pixel:\/\/[^\s`,)]+/g) ?? []).map((uri) => uri.replace(/[.,;:]+$/, ''));
      for (const uri of uris(full.description)) {
        expect(uris(listed.description ?? ''), `${name} dropped ${uri}`).toContain(uri);
      }
      expect(full.description.startsWith(listed.description!.split(' See ')[0])).toBe(true);

      const listedParams = (listed.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
      for (const [key, property] of Object.entries(listedParams)) {
        const served = full.params.properties?.[key]?.description;
        if (property.description && served) {
          expect(served.startsWith(property.description), `${name}.${key}`).toBe(true);
        }
      }
    }
  });

  it('drops the SDK\'s default execution hint and keeps the four that are undeclared without it', async () => {
    // `execution: {taskSupport: "forbidden"}` was 999 bytes across the list to restate
    // what the specification already applies when the field is absent. The four risk
    // hints are the opposite case and stay: they default to "unknown", so omitting one
    // leaves a client guessing rather than told.
    const { tools } = await connect();
    expect(tools.filter((tool) => tool.execution !== undefined).map((tool) => tool.name)).toEqual([]);
    for (const tool of tools) {
      expect(Object.keys(tool.annotations ?? {}).sort()).toEqual([
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
      ]);
    }
  });

  it('registers the full catalogue when asked to', async () => {
    // The escape hatch, and the mode the rest of the suite drives.
    const { tools } = await connect({ commands: 'eager' });
    expect(tools.length).toBeGreaterThan(120);
    expect(tools.map((t) => t.name)).toContain('draw_rect');
  });
});

describe('scripted work', () => {
  it('runs a program from a file, re-read every call', async () => {
    // Found by an agent generating art through run_script: a 10KB generator had to be
    // re-sent on every parameter tweak because there was no way to name a file.
    const dir = mkdtempSync(join(tmpdir(), 'pixel-mcp-script-'));
    try {
      await connect();
      await client.callTool({ name: 'create_document', arguments: { width: 16, height: 16, layers: ['base'] } });
      const file = join(dir, 'tint.js');
      writeFileSync(file, "exec('draw_rect', { rect: { x: 0, y: 0, w: 4, h: 4 }, color: params.color, fill: true });\nreturn params.color;\n");

      const first = payload((await client.callTool({
        name: 'run_script',
        arguments: { path: file, params: { color: '#ff0000' } },
      })) as ToolResult);
      expect(first.ok).toBe(true);
      expect(first.result).toBe('#ff0000');
      // Reported so a caller can see exactly which file ran, including after `~` or a
      // relative path was expanded.
      expect(first.resolvedPath).toBe(file);

      // No caching: the same path, a changed file, a different result.
      writeFileSync(file, "exec('draw_rect', { rect: { x: 0, y: 0, w: 4, h: 4 }, color: params.color, fill: true });\nreturn 'edited';\n");
      const second = payload((await client.callTool({
        name: 'run_script',
        arguments: { path: file, params: { color: '#00ff00' } },
      })) as ToolResult);
      expect(second.result).toBe('edited');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats source and path as alternatives, and needs one', async () => {
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });

    const both = (await client.callTool({
      name: 'run_script',
      arguments: { source: 'return 1;', path: 'nope.js' },
    })) as ToolResult;
    expect(both.isError).toBe(true);
    expect(payload(both).remediation).toMatch(/not both|one or the other/i);

    const neither = (await client.callTool({ name: 'run_script', arguments: {} })) as ToolResult;
    expect(neither.isError).toBe(true);
    expect(payload(neither).code).toBe('invalid_params');
  });

  it('reports an unreadable path with the path it tried', async () => {
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    const result = (await client.callTool({
      name: 'run_script',
      arguments: { path: join(tmpdir(), 'definitely-not-here-9f2a.js') },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body.code).toBe('script_not_readable');
    expect(String(body.resolvedPath)).toContain('definitely-not-here-9f2a.js');
    expect(body.remediation).toBeTruthy();
  });

  it('exposes params to a script run without any', async () => {
    // One file has to work both ways, so `params` is always defined.
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    const result = payload((await client.callTool({
      name: 'run_script',
      arguments: { source: 'return { type: typeof params, keys: Object.keys(params) };' },
    })) as ToolResult);
    expect(result.result).toEqual({ type: 'object', keys: [] });
  });

  it('reports a runtime error with a code, a remapped stack and the source line', async () => {
    // The report that started this asked for a stack and line numbers. The line numbers
    // were already there; the stack, the code and the excerpt were not, and the excerpt
    // is what makes one run enough to find the bug.
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    const source = [
      'function fillRows(rows, col) {',
      '  return rows.map(function (row, i) { return row[col[i]]; });',
      '}',
      'fillRows([[1, 2]]);',
    ].join('\n');

    const result = (await client.callTool({ name: 'run_script', arguments: { source } })) as ToolResult;
    expect(result.isError).toBe(true);
    const body = payload(result);
    // Every failure is branchable, including a plain TypeError.
    expect(body.code).toBe('script_threw');

    const info = body.errorInfo as {
      name: string;
      phase: string;
      line: number;
      column: number;
      sourceLine: string;
      stack: string;
    };
    expect(info.name).toBe('TypeError');
    expect(info.phase).toBe('runtime');
    // Line 2 of the caller's own source, not line 4 of the VM wrapper.
    expect(info.line).toBe(2);
    expect(info.sourceLine).toBe(source.split('\n')[1]);
    // The frames name the caller's file, not `pixel:script`.
    expect(info.stack).toContain('fillRows');
    expect(info.stack).not.toContain('pixel:script');
  });

  it('names the file in the stack when the program came from one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixel-mcp-script-'));
    try {
      await connect();
      await client.callTool({ name: 'create_document', arguments: { width: 16, height: 16, layers: ['base'] } });
      const file = join(dir, 'broken.js');
      writeFileSync(file, 'const rows = [[1, 2]];\nreturn rows.map((r) => r[9].toFixed());\n');
      const result = (await client.callTool({ name: 'run_script', arguments: { path: file } })) as ToolResult;
      expect(result.isError).toBe(true);
      const info = payload(result).errorInfo as { line: number; stack: string; sourceName: string };
      expect(info.line).toBe(2);
      expect(info.sourceName).toBe(file);
      expect(info.stack).toContain('broken.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps logs on the failure path', async () => {
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    const result = (await client.callTool({
      name: 'run_script',
      arguments: { source: "log('about to fail');\nthrow new Error('boom');" },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    // A breadcrumb written before the throw is the cheapest bug report there is.
    expect(payload(result).logs).toEqual(['about to fail']);
  });
});

describe('on-demand command tools', () => {
  it('promotes a command when it is looked up by name', async () => {
    await connect();
    const before = (await client.listTools()).tools.map((t) => t.name);
    expect(before).not.toContain('draw_rect');

    const result = payload((await client.callTool({
      name: 'list_commands',
      arguments: { name: 'draw_rect' },
    })) as ToolResult);
    expect(result.promotedTools).toEqual(['draw_rect']);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('draw_rect');
  });

  it('promotes a command when it is described', async () => {
    await connect();
    const result = payload((await client.callTool({
      name: 'describe_command',
      arguments: { name: 'dither_fill' },
    })) as ToolResult);
    expect(result.nowATool).toBe(true);
    expect(result.promotedTools).toEqual(['dither_fill']);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('dither_fill');
  });

  it('does not promote on a substring browse', async () => {
    // Otherwise one "draw" query would sweep the catalogue into the tool list, which is
    // the thing the small list is for.
    await connect();
    const result = payload((await client.callTool({
      name: 'list_commands',
      arguments: { filter: 'draw' },
    })) as ToolResult);
    expect((result.commands as unknown[]).length).toBeGreaterThan(3);
    expect(result.promotedTools).toEqual([]);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('draw_rect');
  });

  it('promotes the commands a batch actually issued', async () => {
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    const result = payload((await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_rect', rect: { x: 0, y: 0, w: 4, h: 4 }, color: '#f00', fill: true },
          { command: 'add_palette_ramp', from: '#000000', to: '#ffffff', steps: 4 },
        ],
      },
    })) as ToolResult);
    expect(result.promotedTools).toEqual(['draw_rect', 'add_palette_ramp']);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('draw_rect');
    expect(names).toContain('add_palette_ramp');
  });

  it('promotes the commands a script issued, including a dry run', async () => {
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    const result = payload((await client.callTool({
      name: 'run_script',
      arguments: {
        dryRun: true,
        source: 'tryExec("draw_ellipse", { rect: { x: 0, y: 0, w: 8, h: 8 }, color: "#00ff00" });',
      },
    })) as ToolResult);
    expect(result.promotedTools).toEqual(['draw_ellipse']);
  });

  it('promotes the commands a workflow recommends', async () => {
    await connect();
    const result = payload((await client.callTool({
      name: 'find_workflow',
      arguments: { goal: 'paint a coastline on a tilemap' },
    })) as ToolResult);
    const promoted = result.promotedTools as string[];
    expect(promoted).toContain('stroke_tilemap');
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of promoted) expect(names).toContain(name);
  });

  it('says what to change when a batch op fails', async () => {
    // Found by driving the real server: a mistyped command name, a near-miss parameter
    // and an invented layer name are the three likeliest mistakes an agent makes here,
    // and all three came back with nothing but the error text.
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    const op = async (params: Record<string, unknown>) =>
      payload((await client.callTool({
        name: 'apply_ops',
        arguments: { ops: [{ command: 'draw_rect', ...params }] },
      })) as ToolResult);

    const typo = await op({ rect: { x: 0, y: 0, w: 2, h: 2 }, colour: '#f00' });
    const misspelt = (typo.failures as Array<Record<string, string>>)[0];
    expect(misspelt.code).toBe('invalid_params');
    expect(misspelt.remediation).toContain('describe_command');

    const unknown = payload((await client.callTool({
      name: 'apply_ops',
      arguments: { ops: [{ command: 'draw_rekt', rect: { x: 0, y: 0, w: 2, h: 2 } }] },
    })) as ToolResult);
    const bad = (unknown.failures as Array<Record<string, string>>)[0];
    expect(bad.code).toBe('unknown_command');
    expect(bad.remediation).toContain('list_commands');

    const layer = await op({ layer: 'silhouette', rect: { x: 0, y: 0, w: 2, h: 2 }, color: '#f00' });
    const missing = (layer.failures as Array<Record<string, string>>)[0];
    expect(missing.remediation).toContain('get_document');
  });

  it('warns about the hue wheel before the first palette ramp', async () => {
    // Found by drawing: a plum-to-tan ramp interpolates through magenta and red, and
    // nothing in the declaration said so. `add_palette_ramp` is the single most-used
    // command on the server, so its guide has to carry the warning.
    await connect();
    const described = payload((await client.callTool({
      name: 'describe_command',
      arguments: { name: 'add_palette_ramp' },
    })) as ToolResult);
    const command = described.command as { description: string; guide: string };
    expect(command.description).toMatch(/guide/i);
    expect(command.guide).toMatch(/hue/i);
    expect(command.guide).toMatch(/magenta|wheel/i);
    expect(command.guide.length).toBeGreaterThan(600);
  });

  it('recommends a workflow for the most common task', async () => {
    // Found by drawing: "draw a character sprite" matched a rig/timing workflow and
    // promoted four commands that cannot draw anything.
    await connect();
    const result = payload((await client.callTool({
      name: 'find_workflow',
      arguments: { goal: 'draw a hooded character sprite holding a lit lantern' },
    })) as ToolResult);
    const top = (result.workflows as Array<{ id: string }>)[0];
    expect(top.id).toBe('single-sprite');
    const promoted = result.promotedTools as string[];
    expect(promoted).toContain('add_palette_ramp');
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of promoted) expect(names).toContain(name);
  });

  it('a promoted tool actually runs, and says which command it was', async () => {
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 8, height: 8, layers: ['base'] } });
    await client.callTool({ name: 'describe_command', arguments: { name: 'draw_rect' } });

    const drawn = (await client.callTool({
      name: 'draw_rect',
      arguments: { rect: { x: 1, y: 1, w: 3, h: 3 }, color: '#ff0000', fill: true },
    })) as ToolResult;
    const body = payload(drawn);
    expect(body.ok).toBe(true);
    expect(body.command).toBe('draw_rect');
    expect(typeof body.version).toBe('number');
  });

  it('marks a promoted command as such in the catalogue', async () => {
    await connect();
    await (await client.callTool({ name: 'describe_command', arguments: { name: 'outline' } }) as ToolResult);
    const result = payload((await client.callTool({ name: 'list_commands', arguments: {} })) as ToolResult);
    const commands = result.commands as Array<{ name: string; tool: boolean }>;
    expect(commands.find((c) => c.name === 'outline')?.tool).toBe(true);
    expect(commands.find((c) => c.name === 'mirror')?.tool).toBe(false);
  });

  it('describes the entry-point tools too, not just commands', async () => {
    // Found by driving the real server: with only `list_commands` covering commands,
    // there was no route to the schema of the 33 advertised tools, so `apply_ops` and
    // `finalize_document` - the two whose arguments are worth reading - could not be
    // looked up at all.
    await connect();
    const described = payload((await client.callTool({
      name: 'describe_command',
      arguments: { name: 'apply_ops' },
    })) as ToolResult);
    expect(described.kind).toBe('tool');
    const tool = described.tool as { description: string; params: { properties: Record<string, unknown> } };
    expect(tool.description).toContain('one round trip');
    for (const argument of ['ops', 'atomic', 'defaultLayer', 'previewOptions', 'singleUndoStep']) {
      expect(Object.keys(tool.params.properties), `apply_ops.${argument}`).toContain(argument);
    }
    // Described in the same lean dialect the tool list advertises, not a raw one.
    expect(JSON.stringify(tool.params)).not.toContain('-9007199254740991');
    expect(Object.keys(tool.params.properties)).not.toContain('document');
  });

  it('does not tell a caller to search the catalogue for a tool', async () => {
    // The old remediation for an unknown name was always "search list_commands",
    // which could never find `apply_ops` because it was never in the catalogue.
    await connect();
    const wrong = (await client.callTool({
      name: 'describe_command',
      arguments: { name: 'apply_opz' },
    })) as ToolResult;
    expect(wrong.isError).toBe(true);
    const body = payload(wrong);
    expect(body.remediation).not.toContain('list_commands {filter: "apply_opz"}');
  });

  it('serves a command manual on demand instead of in the tool description', async () => {
    await connect();
    const described = payload((await client.callTool({
      name: 'describe_command',
      arguments: { name: 'autotile' },
    })) as ToolResult);
    expect(described.guideUri).toBe('pixel://guide/autotile');
    const command = described.command as { description: string; guide: string };
    expect(command.description.length).toBeLessThan(700);
    expect(command.guide).toContain('Neighbour bits');

    const listed = (await client.listTools()).tools.find((t) => t.name === 'autotile')!;
    expect(listed.description).toContain('pixel://guide/autotile');

    const templates = await client.listResourceTemplates();
    const template = templates.resourceTemplates.find((r) => r.uriTemplate === 'pixel://guide/{command}');
    expect(template, 'the guide resource template must be advertised').toBeTruthy();
    const read = await client.readResource({ uri: 'pixel://guide/autotile' });
    expect(String((read.contents[0] as { text: string }).text)).toContain('Neighbour bits');
  });
});
