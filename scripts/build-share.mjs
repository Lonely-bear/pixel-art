/**
 * `build-share` - turn committed `.pixel` artwork into something a person can actually send to
 * another person, in one command, from a template.
 *
 * `build-gallery.mjs` publishes a page; this publishes a **bundle**, per piece, from a template.
 * It is the same discipline the gallery already established, and the same three commitments,
 * because a share image is strictly more dangerous than a gallery card - it is designed to leave
 * the building:
 *
 *   1. **The artwork is rendered from the `.pixel` source through the engine**, never from a
 *      checked-in `.png`. `open_document` then one `share_bundle` through `apply_ops`, both
 *      advertised, no library import for the render.
 *
 *   2. **No score, grade, rating or percentage is emitted anywhere** - not in `share.json`, not
 *      in the card HTML, not in the PNG's text chunks, not even as a word in the prose. A share
 *      bundle is the most dangerous place in this repository to put a number: it is *designed* to
 *      be looked at and circulated. `AGENTS.md` records what happens when one is: a model told a
 *      lake was clean sanded it into a dark flat rectangle. What travels instead is the **named**
 *      defects - code, dimensions, region, what to do - which is the form that stays actionable
 *      after the reader has thrown the number away.
 *
 *   3. **An unmeasured dimension is not a clean one.** Every abstention is carried in its own
 *      block with its reason spelled out, and never folded into the list of what measured the
 *      piece. `ExcludedReason` exists because "nothing wrong here" and "nobody looked" both arrive
 *      as an absent number, and only one of them is a compliment.
 *
 * ## This script no longer builds a bundle
 *
 * It used to. It composed the render, the badge, the contract and the card itself, and stamped the
 * PNG's text chunks with a direct `fast-png` import - three lines of duplication, and a second
 * place for the provenance vocabulary to drift from the one the engine enforces. The whole of that
 * is now the `share_bundle` core command (`packages/core/src/commands/share.ts`), which the CLI, the
 * MCP server and the desktop app all reach through the one command bus.
 *
 * **What is left here is the half that genuinely is a build script's job:** finding the committed
 * `.pixel` files, driving the MCP server over stdio, decoding the bundle's files and writing them
 * where they belong. Core has no filesystem - `exportAssets` returns bytes and says so, and
 * `finalize_document` is a surface rather than a command - so somebody has to place them, and that
 * somebody is here. Reaching the engine only through the advertised tool surface is what keeps a
 * card in a bundle evidence about the product rather than about a library shortcut.
 *
 * ## Where the presets live, and why not in `recipes/`
 *
 * **In `share-templates/`**, a directory of its own, and the reason is that a recipe and a share
 * template answer different questions. A recipe (`recipes/*.recipe.json`) is *art direction*: what
 * sizes, ramps, layers and mistakes a class of asset keeps making, consumed by `describe_recipe`
 * and `pixel://recipe/{id}` to tell an agent how to draw. A share template is *presentation*: what
 * goes in the bundle and what the card says about it. Conflating them would put a per-audience
 * presentation choice (`bare` vs `review`) into the vocabulary an agent reads to decide what kind
 * of art to make, and every future template would be a new thing `describe_recipe` had to know
 * about. Two directories, two audiences.
 *
 * The schema itself - the closed field set, the checked `format`, the output union - lives in
 * `shareTemplateSchema` on the command, so a template this script never sees is validated by the
 * same code that builds it.
 *
 * ## Determinism
 *
 * A share bundle is a build artifact, so the same repository must produce the same bytes: no clock,
 * no randomness, no locale-dependent formatting, no session id, no absolute path. `share.json`
 * records each PNG's sha256, so a diff shows a real change when the artwork changed and nothing at
 * all when it did not.
 *
 * ## Usage
 *
 * ```bash
 * node scripts/build-share.mjs                       # every template over every piece
 * node scripts/build-share.mjs --template card       # one template
 * node scripts/build-share.mjs --engine phaser       # override the template's target engine
 * node scripts/build-share.mjs --verify              # generate twice and byte-compare
 * node scripts/build-share.mjs --list                # the templates and what they contain
 * ```
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(root, 'packages', 'mcp', 'dist', 'cli.js');
const templateRoot = resolve(root, 'share-templates');
const outRoot = resolve(root, 'share');

const PROTOCOL_VERSION = '2025-06-18';

function flag(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

// ------------------------------------------------------------------ the MCP client

/**
 * A raw JSON-RPC client over stdio, the same shape `build-gallery.mjs`, `showcase-build.mjs` and
 * `mcp-call.mjs` use. This script imports nothing from `@pixel/core`, so what a recipient receives
 * is evidence about the product rather than about a library shortcut.
 */
class Server {
  constructor() {
    this.child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], cwd: root });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: settle, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
        else settle(message.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((settle, reject) => {
      this.pending.set(id, { resolve: settle, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 300_000).unref?.();
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  async start() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'build-share', version: '1.0.0' },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    this.serverInfo = result.serverInfo ?? {};
    return result;
  }

  stop() {
    this.child.kill();
  }

  /** Call one advertised tool, throwing on a refusal. */
  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    const block = (result?.content ?? []).find((b) => b.type === 'text');
    let payload = null;
    try {
      payload = block ? JSON.parse(block.text) : null;
    } catch {
      payload = null;
    }
    if (result?.isError === true || payload?.ok === false) {
      throw new Error(`${name} -> ${payload?.error ?? JSON.stringify(payload ?? result)}`);
    }
    return payload;
  }
}

/**
 * Decode the bundle's bytes.
 *
 * `Buffer.from(x, 'base64')` rather than a hand-rolled table, and the reason is worth stating
 * because a hand-rolled one is exactly what an earlier draft of this file had: it computed the
 * right *length* from the padded input and the wrong *bytes*, because it used `charCodeAt` where
 * base64 needs a character-to-value map. Every length agreed, the byte-count check passed, and 166
 * of the 210 files in the tree were silently corrupt. The fix is not a corrected table, it is not
 * writing the table.
 */
function decodeBundleFile(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

// ------------------------------------------------------------------ templates

/**
 * Read every template and hand each to the command's own schema.
 *
 * **The validation is the engine's, not this file's.** `shareTemplateSchema` on the `share_bundle`
 * command owns the closed field set, the checked `format` and the output union; all this does is
 * read the directory and hand the objects over. A template this script has never seen is validated
 * by exactly the code that builds it, which is the only way the two cannot drift.
 *
 * `JSON.parse` failures name the file, because a malformed template that is silently skipped is a
 * bundle that silently ships less than it claims.
 */
async function loadTemplates() {
  const names = (await readdir(templateRoot)).filter((n) => n.endsWith('.share.json')).sort();
  const templates = [];
  for (const name of names) {
    let raw;
    try {
      raw = JSON.parse(await readFile(join(templateRoot, name), 'utf8'));
    } catch (error) {
      throw new Error(`share-templates/${name}: ${error.message}`);
    }
    templates.push(raw);
  }
  return templates;
}

// ------------------------------------------------------------------ discovery

/**
 * Every committed piece, discovered rather than listed - the same rule as the gallery, for the
 * same reason: a new `.pixel` committed to `artwork/` must be shareable without editing this file.
 */
async function discover() {
  const found = [];
  async function walk(dir) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.name.endsWith('.pixel')) found.push(relative(root, full).split(sep).join('/'));
    }
  }
  await walk(resolve(root, 'artwork'));
  return [...new Set(found)].sort();
}

// ------------------------------------------------------------------ one piece

/**
 * Open one piece and hand the template to `share_bundle`.
 *
 * **Two advertised calls and no more**: `open_document` so the engine is holding the real
 * `.pixel`, then one `apply_ops` carrying the whole bundle as a single op. The `id` and `slug` are
 * derived from the source path exactly as they always were, because they are what makes a bundle's
 * path stable across runs and a person renaming a file should see a diff rather than a new bundle.
 */
async function buildPiece(server, template, sourcePath, engine) {
  const id = sourcePath.startsWith('artwork/')
    ? sourcePath.slice('artwork/'.length).replace(/\.pixel$/, '')
    : sourcePath.replace(/\.pixel$/, '');

  await server.call('open_document', { path: sourcePath });

  const result = await server.call('apply_ops', {
    ops: [
      {
        command: 'share_bundle',
        params: {
          template,
          source: sourcePath,
          id,
          ...(engine ? { engine } : {}),
        },
      },
    ],
  });
  const failure = (result.results ?? []).find((entry) => entry.ok === false);
  if (failure) {
    throw new Error(`${template.id}/${id}: share_bundle -> ${failure.error ?? JSON.stringify(failure)}`);
  }
  const summary = result.results?.[0]?.summary;
  if (!summary?.record || !Array.isArray(summary.files)) {
    throw new Error(`${template.id}/${id}: share_bundle returned no bundle.`);
  }

  const dir = `share/${template.id}/${summary.record.slug}`;
  const dirAbs = resolve(root, dir);
  await mkdir(dirAbs, { recursive: true });
  for (const file of summary.files) {
    const bytes = decodeBundleFile(file.base64);
    if (bytes.byteLength !== file.bytes) {
      throw new Error(`${template.id}/${id}: ${file.path} decoded to ${bytes.byteLength} bytes, expected ${file.bytes}.`);
    }
    const target = join(dirAbs, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  // `share.json` last, so a file on disk can never disagree with the record describing it.
  await writeFile(join(dirAbs, 'share.json'), `${JSON.stringify(summary.record, null, 2)}\n`);
  return summary.record;
}

// ------------------------------------------------------------------ the build

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** sha256 of everything the build wrote, keyed by its path relative to the share root. */
async function writtenHashes() {
  const out = new Map();
  async function walk(dir) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else out.set(relative(outRoot, full).split(sep).join('/'), await sha256File(full));
    }
  }
  await walk(outRoot);
  return out;
}

/**
 * Describe a template by what was **actually built**, not by what it asked for.
 *
 * The engine is read back off the bundles rather than echoed from the flag, because a template with
 * no `engine` output writes no engine files and an index claiming `phaser` over a bundle with none
 * in it is a claim nothing backs. `assetContract` is read the same way: `meta.json` exists or it
 * does not.
 */
function describeTemplate(template, bundles) {
  const built = bundles.filter((bundle) => bundle.template === template.id);
  const engines = new Set(
    built.flatMap((bundle) => (bundle.delivery?.assets ?? []).map((asset) => asset.engine).filter(Boolean)),
  );
  return {
    id: template.id,
    title: template.title,
    summary: template.summary,
    card: built.some((bundle) => bundle.files.some((file) => file.role === 'card')) ? 'card' : null,
    assetContract: built.some((bundle) => bundle.delivery !== null),
    // `null` when the template wrote no engine files at all, and the single name when it wrote one.
    engine: engines.size === 1 ? [...engines][0] : null,
    // The template's **declared** outputs, not the roles the files came out with: this is what a
    // reader asks the index to answer, which is "what does this preset put in a bundle". `png` and
    // `frame` are the same request seen from two ends.
    outputs: (template.outputs ?? []).map((output) => output.type).sort(),
  };
}

async function build() {
  const templates = await loadTemplates();
  const wanted = flag('--template') ? [flag('--template')] : templates.map((t) => t.id);
  const chosen = templates.filter((t) => wanted.includes(t.id));
  if (chosen.length !== wanted.length) {
    throw new Error(
      `no such template: ${wanted.filter((w) => !chosen.some((t) => t.id === w)).join(', ')}`,
    );
  }
  // **The target engine is the caller's choice**, which is why it is a flag here and a parameter on
  // the command rather than something a template can decide alone. One bundle per engine, not one
  // bundle per piece per engine: two engines means two runs with two `--engine` values.
  const engine = flag('--engine');

  const server = new Server();
  try {
    await server.start();
    const sources = await discover();
    const bundles = [];
    for (const template of chosen) {
      for (const source of sources) bundles.push(await buildPiece(server, template, source, engine));
    }
    const index = {
      generatedBy: 'scripts/build-share.mjs',
      engine: {
        name: server.serverInfo.name ?? 'dotloom-mcp',
        version: server.serverInfo.version ?? '0.0.0',
      },
      // Published so a consumer knows the vocabulary the bundles' `notMeasured` keys are drawn
      // from, in pipeline order. The pipeline owns the list; this only restates it.
      dimensions: [
        'silhouette',
        'value',
        'palette',
        'noise',
        'outline',
        'motion',
      ],
      templates: chosen.map((t) => describeTemplate(t, bundles)),
      bundles,
    };
    await writeFile(resolve(outRoot, 'share.json'), `${JSON.stringify(index, null, 2)}\n`);
    return index;
  } finally {
    server.stop();
  }
}

if (process.argv.includes('--list')) {
  for (const t of await loadTemplates()) {
    process.stdout.write(
      `${t.id.padEnd(10)} ${(t.outputs ?? []).map((o) => o.type).join('+').padEnd(28)} ${t.summary}\n`,
    );
  }
} else {
  try {
    const index = await build();
    process.stdout.write(
      `share: ${index.bundles.length} bundle(s) across ${index.templates.length} template(s)\n`,
    );
    for (const b of index.bundles) {
      process.stdout.write(
        `  ${`${b.template}/${b.id}`.padEnd(40)} ${String(b.issues.length).padStart(2)} named defect(s)  ` +
          `${b.notMeasured.length} not measured\n`,
      );
    }
    if (process.argv.includes('--verify')) {
      const before = await writtenHashes();
      await build();
      const after = await writtenHashes();
      const names = [...new Set([...before.keys(), ...after.keys()])].sort();
      const drifted = names.filter((n) => before.get(n) !== after.get(n));
      if (drifted.length) {
        process.stderr.write(`NOT REPRODUCIBLE: ${drifted.join(', ')}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(
          `  verified: a second generation produced byte-identical output for ${names.length} file(s)\n`,
        );
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
