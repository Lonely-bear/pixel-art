/**
 * The recipe catalogue as the server serves it.
 *
 * Two things are being checked here, and they are checked here rather than in
 * `packages/core/test/recipes.test.ts` because both need a name set that `packages/core`
 * cannot see.
 *
 * 1. **The catalogue is served.** `describe_recipe` and `pixel://recipe/{id}` are two
 *    readers of the same files, and the failure this file exists to prevent is one of
 *    them quietly serving different bytes from the other. A recipe id is also the URI path
 *    segment, so an id that resolves at one and not the other is a channel an agent cannot
 *    discover.
 *
 * 2. **Recipe prose names tools that exist.** `unknown_check_tool` validates
 *    `checks[].tool` and nothing else, so the rest of a recipe's prose - which is where an
 *    agent learns *which* tool answers a question - is unguarded by the schema. The
 *    admissible name set is the advertised tool list plus the command catalogue, and that
 *    union only exists on the server side, so this is the only place it can be checked.
 *
 * The bytes are read through `parseRecipe` on both paths, so neither reader has its own
 * copy of the schema; that is the property `packages/core/src/recipes.ts` documents and
 * this file is what would fail if a second copy appeared.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCommands, createRegistry, RECIPE_CHECK_TOOLS } from '@pixel/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createPixelServer, type PixelServer } from '../src/server.js';

const RECIPES_DIR = fileURLToPath(new URL('../../../recipes/', import.meta.url));

/** The five recipes T-030..T-035 are meant to ship. A recipe lands as a file, and this is the line that moves with it. */
const CATALOGUE = ['dungeon-tileset', 'item-icons', 'platformer', 'topdown-rpg', 'ui-icons'];

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content.find((c) => c.type === 'text')?.text ?? '{}');
}

let client: Client;
let pixel: PixelServer;

async function connect(): Promise<void> {
  pixel = createPixelServer({ initialDocument: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'recipe-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), pixel.server.connect(serverTransport)]);
}

afterEach(async () => {
  await client?.close();
  await pixel?.server.close();
});

describe('recipe catalogue', () => {
  it('lists every shipped recipe from the tool and the catalogue resource', async () => {
    await connect();
    const listed = payload((await client.callTool({ name: 'describe_recipe', arguments: {} })) as ToolResult);
    expect(listed.ok).toBe(true);
    expect(listed.ids).toEqual(CATALOGUE);
    expect(listed.count).toBe(CATALOGUE.length);

    // One line per recipe, each naming the id, the default canvas and the URI it can also
    // be read from. A listing entry without a URI is a dead end for a client that prefers
    // resources to tool calls.
    const recipes = listed.recipes as Array<Record<string, unknown>>;
    expect(recipes).toHaveLength(CATALOGUE.length);
    for (const [index, id] of CATALOGUE.entries()) {
      expect(recipes[index].id).toBe(id);
      expect(recipes[index].uri).toBe(`pixel://recipe/${id}`);
      expect(typeof recipes[index].summary).toBe('string');
      // And the summary is a whole sentence, not a truncation: `summarise` cuts at the
      // first full stop precisely so a listing never shows half a clause.
      expect(String(recipes[index].summary).trimEnd().endsWith('.')).toBe(true);
    }

    // The same list, from the resource, byte for byte per entry. Two readers over one
    // catalogue must not disagree about what is in it.
    const read = await client.readResource({ uri: 'pixel://recipes' });
    const body = JSON.parse(String((read.contents[0] as { text: string }).text)) as {
      ids?: string[];
      recipes?: Array<Record<string, unknown>>;
    };
    expect(body.recipes).toEqual(recipes);
  });

  it('serves each recipe whole, identically, through the tool and the resource', async () => {
    await connect();
    for (const id of CATALOGUE) {
      const viaTool = payload((await client.callTool({ name: 'describe_recipe', arguments: { id } })) as ToolResult);
      expect(viaTool.ok, id).toBe(true);
      expect(viaTool.id).toBe(id);
      expect(viaTool.source).toBe(`recipes/${id}.recipe.json`);

      const read = await client.readResource({ uri: `pixel://recipe/${id}` });
      const body = JSON.parse(String((read.contents[0] as { text: string }).text)) as Record<string, unknown>;
      expect(body.source).toBe(viaTool.source);
      // Deep equality, not a spot check: the two readers exist to serve the same document,
      // and an id that resolves through one of them with different bytes is the failure
      // this assertion is the only guard against.
      expect(body.recipe, id).toEqual(viaTool.recipe);
    }
  });

  it('advertises the recipe resource template and lists every id on it', async () => {
    await connect();
    const templates = await client.listResourceTemplates();
    const template = templates.resourceTemplates.find((r) => r.uriTemplate === 'pixel://recipe/{id}');
    expect(template, 'the recipe resource template must be advertised').toBeTruthy();

    // `list: undefined` on the other templates means they are deliberately invisible until
    // the client knows an id. This one lists, because the catalogue is the discovery path
    // for a format whose whole point is that recipes are files.
    const listed = await client.listResources();
    // Filtered: `resources/list` also returns the static resources (`pixel://skill`,
    // `pixel://commands`, ...), and the assertion is about what the *template* contributes.
    const uris = listed.resources
      .map((r) => r.uri)
      .filter((uri) => uri.startsWith('pixel://recipe/'))
      .sort();
    expect(uris).toEqual(CATALOGUE.map((id) => `pixel://recipe/${id}`));
  });

  it('refuses an unknown id by name, and lists what does exist', async () => {
    // The listing in the message is the whole recovery: a catalogue is small enough to
    // print, and an agent handed "no recipe named X" with nothing else spends a round trip
    // on the listing it should have been given.
    await connect();
    const missing = (await client.callTool({
      name: 'describe_recipe',
      arguments: { id: 'not-a-recipe' },
    })) as ToolResult;
    expect(missing.isError).toBe(true);
    const body = payload(missing);
    expect(body.code).toBe('unknown_recipe');
    expect(String(body.error)).toContain('not-a-recipe');
    for (const id of CATALOGUE) expect(String(body.error)).toContain(id);
    // Held under the ~320-char cap the surface test enforces, so a five-recipe catalogue
    // can grow before the refusal becomes unreadable.
    expect(String(body.error).length).toBeLessThanOrEqual(320);

    await expect(client.readResource({ uri: 'pixel://recipe/not-a-recipe' })).rejects.toThrow(/not-a-recipe/);
  });

  it('refuses a path-shaped id before the filesystem is touched', async () => {
    // `describe_recipe {id}` is the one tool whose argument becomes a path segment, and
    // the guard that stops `../../` living in the catalogue is in the loader rather than in
    // the caller - because the resource is the other caller, and a traversal guard that
    // lives in one of two callers is a guard the other does not have.
    await connect();
    for (const id of ['../recipes/platformer', 'a/b', 'UPPER', '']) {
      const result = payload((await client.callTool({ name: 'describe_recipe', arguments: { id } })) as ToolResult);
      expect(result.code, `id ${JSON.stringify(id)}`).toBe('unknown_recipe');
    }
  });
});

describe('recipe prose names tools that exist', () => {
  it('resolves every underscored tool a recipe mentions against the live surface', async () => {
    // `unknown_check_tool` validates `checks[].tool`; the rest of the prose is unguarded.
    // The token shape is deliberate: an underscored backticked word in a recipe is a
    // command or a session tool, while the layer and field names a recipe also uses
    // (`base`, `shade`, `detail`) are single words. So this is one-directional - it cannot
    // fire on prose, and it does fire on a rename.
    //
    // Deliberately not exhaustive: single-word commands (`outline`, `squash`, `translate`)
    // do not match, because ordinary words appear in backticks in prose and a wider match
    // would be all false positives.
    await connect();
    const advertised = (await client.listTools()).tools.map((tool) => tool.name);
    const known = new Set<string>([
      ...advertised,
      ...createRegistry(allCommands).list().map((command) => command.name),
      ...RECIPE_CHECK_TOOLS,
    ]);

    const names = readdirSync(RECIPES_DIR).filter((name) => name.endsWith('.recipe.json')).sort();
    expect(names.length).toBeGreaterThan(0);

    // The control on the control: this rule is only worth anything if it fires in one
    // direction and stays quiet in the other. A token that exists passes, a near-miss on
    // the same shape does not - asserted here rather than left to the catalogue, because a
    // regex that matched nothing would make every recipe below it vacuously clean.
    expect(known.has('add_palette_ramp')).toBe(true);
    expect(known.has('add_palette_rramp')).toBe(false);
    expect([...'`add_palette_ramp` and `add_palette_rramp`'.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)].map((m) => m[1])).toEqual([
      'add_palette_ramp',
      'add_palette_rramp',
    ]);

    for (const name of names) {
      const text = readFileSync(`${RECIPES_DIR}${name}`, 'utf8');
      const referenced = new Set([...text.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)].map((m) => m[1]));
      // At least one, so the guard below is not a rule that never has anything to check.
      expect(referenced.size, `${name} names no tool`).toBeGreaterThan(0);
      const unknown = [...referenced].filter((token) => !known.has(token)).sort();
      expect(unknown, `${name} names tools that do not exist: ${unknown.join(', ')}`).toEqual([]);
    }
  });
});

describe('the recipe tool against the advertised budget', () => {
  it('sits inside the tool-count and byte ceilings', async () => {
    // The ceiling is what stops a session tool from quietly costing tokens of every
    // request in every session. This test re-states the numbers `tool-surface.test.ts`
    // owns and does not raise them; it records what this build actually advertises so a
    // regression shows up as a number moving rather than as a prose claim.
    await connect();
    const { tools } = await client.listTools();
    const bytes = tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
    expect(tools.map((tool) => tool.name)).toContain('describe_recipe');
    expect(tools.length).toBeLessThanOrEqual(40);
    expect(bytes).toBeLessThanOrEqual(100_000);
    // Written rather than logged: vitest swallows `console` output in some reporters, and
    // this number is the one the report has to quote.
    writeFileSync(
      join(tmpdir(), 'pixel-mcp-surface.json'),
      JSON.stringify(
        {
          tools: tools.length,
          bytes,
          describeRecipeBytes: JSON.stringify(tools.find((t) => t.name === 'describe_recipe')).length,
        },
        null,
        2,
      ),
    );
  });
});