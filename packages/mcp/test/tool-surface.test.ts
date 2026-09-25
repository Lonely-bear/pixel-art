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
 * The two tools allowed to run past the description budget.
 *
 * `apply_ops` and `run_script` are the two ways to issue many commands at once, so
 * their schemas and their inline/param/undo/preview conventions genuinely do not fit
 * in a paragraph. Everything else has to.
 */
const DESCRIPTION_BUDGET: Record<string, number> = {
  apply_ops: 900,
  run_script: 1000,
  // The tilemap preview is the one place a structural defect has to be seen rather
  // than described, so it names its overlays instead of deferring to the schema.
  preview_tilemap: 600,
  // Three modes to choose between — full, `brief`, and `assetType: "character"` — and
  // the report is the step every workflow ends on, so its description is the one worth
  // being explicit in.
  quality_report: 700,
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
    for (const always of ['get_preview', 'preview_animation', 'quality_report', 'finalize_document', 'get_document']) {
      expect(names).toContain(always);
    }
    // And the catalogue really is not in the list.
    expect(names).not.toContain('draw_rect');
    expect(names).not.toContain('autotile');
  });

  it('stays inside its token budget', async () => {
    const { tools } = await connect();
    const bytes = tools.reduce((sum, t) => sum + JSON.stringify(t).length, 0);
    // 33 tools / ~82KB measured. The budget is what stops a new tool from quietly
    // costing 4K tokens of every request in every session.
    expect(tools.length).toBeLessThanOrEqual(40);
    expect(bytes).toBeLessThanOrEqual(100_000);
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

describe('quality report payload', () => {
  async function spriteReport(brief = false) {
    await connect();
    await client.callTool({ name: 'create_document', arguments: { width: 96, height: 96, layers: ['base'] } });
    await client.callTool({
      name: 'apply_ops',
      arguments: {
        ops: [
          { command: 'draw_ellipse', rect: { x: 20, y: 12, w: 56, h: 60 }, color: '#8a5a3a', fill: true },
          { command: 'draw_ellipse', rect: { x: 30, y: 24, w: 14, h: 10 }, color: '#ffffff', fill: true },
        ],
      },
    });
    return payload((await client.callTool({
      name: 'quality_report',
      arguments: brief ? { brief: true } : {},
    })) as ToolResult) as Record<string, unknown>;
  }

  it('reaches no block from two paths', async () => {
    // The same landscape object used to be serialised at `landscape` and
    // `structure.landscape`, with its horizon/ridge/waterline/guideLines repeated a
    // level up: five copies, 2.4KB of a 4.9KB response.
    const report = await spriteReport();
    const structure = report.structure as Record<string, unknown>;
    expect(report.landscape).toBeUndefined();
    expect(structure.horizon).toBeUndefined();
    expect(structure.ridge).toBeUndefined();
    expect(structure.waterline).toBeUndefined();
    expect(structure.guideLines).toBeUndefined();
    expect(structure.landscape).toBeTruthy();
  });

  it('drops the identity aliases that were three names for one number', async () => {
    const report = await spriteReport();
    expect(report.softnessScore).toBeUndefined();
    const presence = report.presence as Record<string, unknown>;
    expect(presence.lightShare).toBeUndefined();
    // The two that remain still say the same thing, which is the point.
    expect(typeof presence.brightestShare).toBe('number');
    expect(report.overexposedRatio).toBe(presence.brightestShare);
  });

  it('collapses an unmeasurable landscape to a verdict', async () => {
    const report = await spriteReport();
    const landscape = (report.structure as { landscape: Record<string, unknown> }).landscape;
    expect(landscape.measurable).toBe(false);
    expect(landscape.scene).toBeTruthy();
    expect(landscape.conclusion).toBeTruthy();
    // The page of nulls is gone; the question it answered is not.
    expect(landscape.horizon).toBeUndefined();
    expect(landscape.horizontalBoundaries).toBeUndefined();
  });

  it('brief keeps every number the craft guide tells a model to read', async () => {
    const brief = await spriteReport(true);
    const at = (path: string): unknown => path.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], brief);
    for (const path of [
      'defectScore', 'defectScoreContext',
      'noise.isolatedRatio', 'noise.outliers', 'noise.texturedOutliers',
      'edges.meanAdjacentDelta', 'overexposedRatio',
      'palette.outsideRatio', 'palette.unusedIndices', 'palette.crowded',
      'structure.strongBands',
      'presence.valueRange', 'presence.darkShare', 'presence.flatShare',
      'presence.planeSeparation', 'presence.lightConcentration',
    ]) {
      expect(at(path), `brief is missing ${path}`).toBeDefined();
    }
    // And nothing that only adds weight.
    expect(brief.brief).toBe(true);
    expect((brief.structure as Record<string, unknown>).landscape).toBeUndefined();
    expect((brief.presence as Record<string, unknown>).planes).toBeUndefined();
    expect((brief.presence as Record<string, unknown>).lightShare).toBeUndefined();
    for (const warning of brief.warnings as Array<Record<string, unknown>>) {
      expect(Object.keys(warning).sort()).toEqual(['code', 'severity']);
    }
  });

  it('brief is a fraction of the bytes and reports the same analysis', async () => {
    const full = await spriteReport();
    const brief = await spriteReport(true);
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    expect(size(brief)).toBeLessThan(size(full) * 0.5);
    // Same analysis: the shared numbers are identical, not re-derived.
    expect(brief.defectScore).toBe(full.defectScore);
    expect(brief.opaqueRatio).toBe(full.opaqueRatio);
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
