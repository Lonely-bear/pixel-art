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
 *      checked-in `.png`. `open_document` then `export_png`, both advertised tools, no library
 *      import for the render.
 *
 *   2. **No score, grade, rating or percentage is emitted anywhere** - not in `share.json`, not
 *      in the card HTML, not in the PNG's text chunks, not even as a word in the prose. A share
 *      bundle is the most dangerous place in this repository to put a number: it is *designed* to
 *      be looked at and circulated. `AGENTS.md` records what happens when one is: a model told a
 *      lake was clean sanded it into a dark flat rectangle. What travels instead is the **named**
 *      defects - code, dimension, region, what to do - which is the form that stays actionable
 *      after the reader has thrown the number away.
 *
 *   3. **An unmeasured dimension is not a clean one.** Every abstention is carried in its own
 *      block with its `ExcludedReason` spelled out, and never folded into the list of what
 *      measured the piece. `ExcludedReason` exists because "nothing wrong here" and "nobody
 *      looked" both arrive as an absent number, and only one of them is a compliment.
 *
 * ## The badge
 *
 * **Carried as metadata, never burned into the pixels.** `encodePNG({metadata})` writes PNG
 * `tEXt` chunks and changes no pixel, so the asset underneath the badge is still recoverable by
 * decoding the file - whereas a burned badge is indistinguishable from artwork, is unrecoverable
 * by anyone who did not watch it happen, and quietly changes what every downstream engine
 * resamples and recolours. A wordmark on the *card* is presentation and costs nothing; a wordmark
 * on the *sprite* is a decision about the sprite that nobody asked for.
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
 * ## Determinism
 *
 * A share bundle is a build artifact, so the same repository must produce the same bytes: no clock,
 * no randomness, no locale-dependent formatting, no session id, no absolute path. `share.json`
 * records each file's sha256, so a diff shows a real change when the artwork changed and nothing
 * at all when it did not.
 *
 * ## Usage
 *
 * ```bash
 * node scripts/build-share.mjs                       # every template over every piece
 * node scripts/build-share.mjs --template card       # one template
 * node scripts/build-share.mjs --verify              # generate twice and byte-compare
 * node scripts/build-share.mjs --list                # the templates and what they contain
 * ```
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { decode as decodePng, encode as encodePng } from 'fast-png';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(root, 'packages', 'mcp', 'dist', 'cli.js');
const templateRoot = resolve(root, 'share-templates');
const outRoot = resolve(root, 'share');

const PROTOCOL_VERSION = '2025-06-18';

/** How large a rendered piece is upscaled to, in pixels on its long side, when a template is silent. */
const TARGET_LONG_SIDE = 256;

/** The dimension set, in pipeline order, for the card's legend. Mirrors `build-gallery.mjs`. */
const DIMENSIONS = ['silhouette', 'value', 'palette', 'noise', 'outline', 'motion'];

/** The badge, as the PNG spec's own `Software` keyword. No version - see ASSET-CONTRACT S10. */
const BADGE = 'dotloom-mcp';

/**
 * Why a dimension abstained, in words a reader can act on. Copied from `build-gallery.mjs`
 * deliberately: two surfaces saying the same thing in two vocabularies is how they drift apart,
 * and a share bundle that explained an abstention less carefully than the gallery would be a
 * regression travelling outward.
 */
const EXCLUSION_NOTES = {
  'no-subject':
    'the ink runs to the frame on every edge, so the alpha boundary *is* the canvas and there is no shape to read. Measured on a different canvas, not on a different drawing.',
  'no-outline':
    'this document declares no drawn contour. That is a legitimate style - a scene is not a sticker - so the dimension abstains rather than scoring it.',
  'single-frame': 'the evaluated sequence is one frame, so there is nothing to measure motion across.',
  'no-motion-content':
    'every frame is byte-identical, so there is no motion to measure. An honest analyser asked to score this would return its best possible reading for a sprite that does not move; abstaining is the only truthful answer.',
  'not-implemented':
    'this build has no analyser for this dimension. That is a claim about the engine, not about the artwork.',
};

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function titleFromId(id) {
  const last = id.split('/').pop() ?? id;
  return last
    .replace(/-\d+x\d+$/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function slugFor(id) {
  return id.replace(/[^\w.-]+/g, '--');
}

/**
 * A path relative to the bundle directory, forward-slashed on every platform.
 *
 * `finalize_document` reports absolute, platform-native paths, and a bundle whose own file list
 * contains `share\\handoff\\...` cannot be moved to a Linux build machine - which is exactly
 * what ASSET-CONTRACT S5.1 exists to prevent. The rule is that the *record* of a bundle is as
 * portable as the bundle.
 */
function bundleRelative(dir, target) {
  const rel = relative(resolve(root, dir), resolve(root, target)).split(sep).join('/');
  return rel;
}

// ------------------------------------------------------------------ the MCP client

/**
 * A raw JSON-RPC client over stdio, the same shape `build-gallery.mjs`, `showcase-build.mjs` and
 * `mcp-call.mjs` use. This script imports nothing from `@pixel/core` for the *render*, so what a
 * recipient receives is evidence about the product rather than about a library shortcut.
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

  /**
   * Call one advertised tool, throwing on a refusal.
   *
   * `allowFailure` exists for exactly one caller - the delivery gate - because a refusal there is
   * information the bundle has to carry, not an error the build should die on.
   */
  async call(name, args = {}, { allowFailure = false } = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    const block = (result?.content ?? []).find((b) => b.type === 'text');
    let payload = null;
    try {
      payload = block ? JSON.parse(block.text) : null;
    } catch {
      payload = null;
    }
    const failed = result?.isError === true || payload?.ok === false;
    if (failed && !allowFailure) {
      throw new Error(`${name} -> ${payload?.error ?? JSON.stringify(payload ?? result)}`);
    }
    return payload;
  }
}

// ------------------------------------------------------------------ templates

/**
 * Read every template, and refuse anything this loader does not understand.
 *
 * A closed field set and a checked `format`, because a template is *presentation policy* and a
 * typo in one would otherwise be silently ignored - the failure mode `ASSET-CONTRACT` S3 calls out
 * by name: tolerance for the future must not become tolerance for typos, so an unrecognised key is
 * an error here rather than a default.
 */
async function loadTemplates() {
  const names = (await readdir(templateRoot)).filter((n) => n.endsWith('.share.json')).sort();
  const templates = [];
  for (const name of names) {
    const raw = JSON.parse(await readFile(join(templateRoot, name), 'utf8'));
    const known = new Set([
      'format',
      'schemaVersion',
      'id',
      'title',
      'summary',
      'outputs',
      'card',
      'assetContract',
      'engine',
      'license',
    ]);
    const unknown = Object.keys(raw).filter((k) => !known.has(k));
    if (unknown.length) {
      throw new Error(`share-templates/${name}: unknown field(s) ${unknown.join(', ')}`);
    }
    if (raw.format !== 'dotloom-mcp/share-template') {
      throw new Error(`share-templates/${name}: format must be "dotloom-mcp/share-template"`);
    }
    if (raw.schemaVersion !== 1) {
      throw new Error(`share-templates/${name}: schemaVersion must be 1, got ${raw.schemaVersion}`);
    }
    if (!name.startsWith(`${raw.id}.`)) {
      throw new Error(`share-templates/${name}: id "${raw.id}" does not match its filename`);
    }
    if (!Array.isArray(raw.outputs) || raw.outputs.length === 0) {
      throw new Error(`share-templates/${name}: outputs must be a non-empty array`);
    }
    for (const output of raw.outputs) {
      if (output.type === 'engine' && !output.engine) {
        throw new Error(`share-templates/${name}: an engine output must name an engine`);
      }
      if (output.type === 'engine' && !raw.engine) {
        throw new Error(`share-templates/${name}: an engine output must also set the top-level engine`);
      }
      if (raw.license !== null && raw.license !== undefined && typeof raw.license !== 'string') {
        throw new Error(`share-templates/${name}: license must be an SPDX string or null`);
      }
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

// ------------------------------------------------------------------ the badge

/**
 * Write the badge and the asset's provenance into a rendered PNG's text chunks, leaving every
 * pixel exactly as the engine produced it.
 *
 * The one library shortcut in this script, and it is deliberate and narrow: `fast-png` decodes the
 * file the *engine* wrote and re-encodes the same RGBA with `tEXt` chunks attached. Nothing about
 * the artwork is recomputed or re-derived here - `packages/core/test/share-templates.test.ts`
 * asserts the decoded RGBA is byte-identical before and after, which is the only claim that makes
 * "the badge is not burned in" true rather than merely asserted in a comment.
 */
async function writeBadgedPng(renderedPath, text) {
  const bytes = new Uint8Array(await readFile(renderedPath));
  const decoded = decodePng(bytes);
  const sorted = Object.fromEntries(Object.keys(text).sort().map((key) => [key, text[key]]));
  const out = encodePng({
    width: decoded.width,
    height: decoded.height,
    data: decoded.channels === 4 ? decoded.data : new Uint8Array(decoded.data),
    channels: 4,
    depth: 8,
    text: sorted,
  });
  await writeFile(renderedPath, out);
  return out.length;
}

// ------------------------------------------------------------------ one piece

/**
 * Open, render, judge and bundle one piece under one template.
 *
 * Advertised tool calls only: `open_document`, `get_document`, `export_png`, `evaluate`, one
 * `fix` through `apply_ops`, and - for a template that wants them - `finalize_document` for the
 * contract and the engine files.
 */
async function buildPiece(server, template, sourcePath) {
  const id = sourcePath.startsWith('artwork/')
    ? sourcePath.slice('artwork/'.length).replace(/\.pixel$/, '')
    : sourcePath.replace(/\.pixel$/, '');
  const slug = slugFor(id);
  const dir = `share/${template.id}/${slug}`;
  const dirAbs = resolve(root, dir);

  await server.call('open_document', { path: sourcePath });
  const info = await server.call('get_document');
  const doc = info.document;

  const longSide = Math.max(doc.width, doc.height);
  const wanted = template.outputs.find((o) => o.type === 'png');
  const scale = Math.max(1, Math.min(8, Math.floor((wanted?.targetLongSide ?? TARGET_LONG_SIDE) / longSide)));
  const imageName = `${slug}.png`;
  const imagePath = `${dir}/${imageName}`;
  await server.call('export_png', { out: imagePath, scale });

  // A sheet or a contact strip, when the template asks for one. Rendered with the advertised
  // export tools rather than through `finalize_document`: the quality gate is a *delivery* gate,
  // and a review card that cannot be opened because a defect blocked a handoff is the wrong trade.
  // These files carry no badge - the badge belongs to the piece, not to every strip of it - and
  // nothing reads them back, so there is nothing to declare.
  const extra = [];
  const sheet = template.outputs.find((o) => o.type === 'sheet');
  if (sheet) {
    const sheetPath = `${dir}/${slug}_sheet.png`;
    await server.call('export_sheet', {
      out: sheetPath,
      json: `${dir}/${slug}_sheet.json`,
      layout: sheet.layout ?? 'horizontal',
      scale: sheet.scale ?? 1,
    });
    extra.push({ role: 'sheet', path: `${slug}_sheet.png` });
    extra.push({ role: 'sheet-json', path: `${slug}_sheet.json` });
  }

  const judgement = await server.call('evaluate', {});
  const plan = await server.call('apply_ops', { ops: [{ command: 'fix', params: {} }] });
  const plans = plan.results?.[0]?.summary?.plans ?? [];
  const byCode = new Map(plans.map((p) => [p.code, p]));

  // Named defects, one entry per code, sorted by code so the order is a property of the data and
  // not of a hash map. No severity number: `severity` is 0..1 and is a number, and a number in a
  // file that gets forwarded is the thing this repository has already paid for.
  const seen = new Set();
  const issues = [];
  for (const issue of judgement.issues ?? []) {
    if (seen.has(issue.code)) continue;
    seen.add(issue.code);
    const repair = byCode.get(issue.code);
    issues.push({
      code: issue.code,
      dimensions: [...(issue.dimensions ?? [])].sort(),
      rect: issue.rect ?? null,
      blocking: issue.blocking === true,
      message: oneLine(issue.message),
      disposition: repair?.fix === 'ops' ? 'safe-repair-available' : 'needs-a-decision',
      guidance: repair ? oneLine(repair.guidance) : null,
    });
  }
  issues.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const excluded = Object.entries(judgement.excludedDimensions ?? {})
    .map(([dimension, reason]) => ({
      dimension,
      reason,
      note: EXCLUSION_NOTES[reason] ?? `reason: ${reason}`,
    }))
    .sort((a, b) => (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0));

  // A *partly* absent dimension is the case with no precedent, and to a reader it is the same
  // fact as a whole-dimension abstention: part of this claim was not checked. So it goes in the
  // same block, never folded into the measured list.
  const partial = [];
  for (const [dimension, detail] of Object.entries(judgement.report?.dimensions ?? {})) {
    for (const [sub, reason] of Object.entries(detail.unmeasured ?? {})) {
      partial.push({
        dimension: `${dimension}.${sub}`,
        reason,
        note:
          (EXCLUSION_NOTES[reason] ?? `reason: ${reason}`) +
          ' The rest of this dimension was measured and is reported normally; this one term is absent, not counted at its best.',
      });
    }
  }
  const notMeasured = [...excluded, ...partial].sort((a, b) =>
    a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0,
  );

  // ---- provenance. Every value is either true of these bytes or declared by the caller, and
  // `dotloom:license` is written only when the template supplies one - S11: never invent what the
  // document does not know, and absent is not public domain.
  const text = { Software: BADGE, 'dotloom:name': doc.name ?? slug, 'dotloom:defects': issues.map((i) => i.code).join(',') };
  if (template.license) text['dotloom:license'] = template.license;
  let imageBytes = await writeBadgedPng(resolve(root, imagePath), text);

  // ---- the optional half: the contract and one engine's files, opt-in exactly as
  // `finalize_document` has always been. A refusal is carried, not thrown: a bundle that says the
  // delivery gate stopped it is more useful than no bundle.
  let delivery = null;
  if (template.assetContract) {
    const finalize = await server.call(
      'finalize_document',
      {
        // The editable source travels with the bundle. `path` is required by finalize_document and
        // it is pointed *into the bundle*, never back at `artwork/`: a share build that rewrote
        // the artwork it is sharing would be the same class of mistake as a gallery that renders
        // from checked-in PNGs.
        path: `${dir}/${slug}.pixel`,
        outputs: [
          {
            ...(template.engine
              ? { type: 'engine', engine: template.engine }
              : { type: 'meta' }),
            path: `${dir}/meta.json`,
            // The bundle's other files, declared. An engine importer that is told about no frames
            // and no sheet emits resources pointing at textures that are not there, and warns
            // about it in the very file it just wrote.
            outputs: [
              { role: 'source', path: `${slug}.pixel` },
              { role: 'frame', path: imageName },
              ...(sheet
                ? [{ role: 'sheet-json', path: `${slug}_sheet.json` }]
                : []),
            ],
            // The sheet is named, not re-rendered: `assetMetaOptions` in the MCP tool derives
            // `sheet.regions` from the sheet output *in the same plan*, and re-packing here would
            // describe a sheet nobody is shipping.
            ...(sheet ? { sheet: `${slug}_sheet.png` } : {}),
          },
        ],
      },
      { allowFailure: true },
    );
    delivery =
      finalize?.ok === false
        ? { refused: true, reason: oneLine(String(finalize.error ?? '')) }
        : {
            refused: false,
            files: (finalize?.outputs ?? [])
              .map((o) => o.path)
              .filter((p) => typeof p === 'string' && !p.endsWith('.pixel'))
              .map((p) => bundleRelative(dir, p))
              .sort(),
            assets: (finalize?.assets ?? []).map((a) => ({
              path: bundleRelative(dir, a.path),
              contentHash: a.contentHash,
              schemaVersion: a.schemaVersion,
              engine: a.engine?.engine ?? null,
            })),
          };
    // The contract carries the identity the text chunks claim, so it goes back into the chunk set
    // and the badge is written a second time with the real hash beside it. That round trip is the
    // point: a recipient can check the file against the contract without re-compositing anything.
    if (delivery?.refused !== true) {
      const contract = delivery.assets?.[0];
      if (contract) {
        text['dotloom:asset'] = contract.contentHash;
        text['dotloom:contract'] = 'dotloom-mcp/asset-meta';
        text['dotloom:schema'] = String(contract.schemaVersion);
        imageBytes = await writeBadgedPng(resolve(root, imagePath), text);
      }
    }
  }

  const files = [
    { role: 'frame', path: imageName },
    ...extra,
    ...(delivery?.files ?? []).map((p) => ({ role: 'asset', path: p })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const record = {
    id,
    slug,
    title: titleFromId(id),
    template: template.id,
    source: sourcePath,
    width: doc.width,
    height: doc.height,
    layers: doc.layerCount,
    frames: doc.frameCount,
    image: imageName,
    imageBytes,
    imageSha256: createHash('sha256').update(await readFile(resolve(root, imagePath))).digest('hex'),
    badge: { carriedAs: 'png-text-chunk', keyword: 'Software', value: BADGE, burnedIn: false },
    provenance: Object.fromEntries(Object.keys(text).sort().map((k) => [k, text[k]])),
    assetClass: judgement.assetClass?.cls ?? judgement.report?.assetClass?.cls ?? 'unknown',
    measuredDimensions: [...(judgement.measuredDimensions ?? [])].sort(),
    notMeasured,
    issues,
    delivery,
    files,
  };

  if (template.card) {
    await writeFile(join(dirAbs, 'card.html'), renderCard(record, template));
    record.files.push({ role: 'card', path: 'card.html' });
    record.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  await writeFile(join(dirAbs, 'share.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// ------------------------------------------------------------------ the card

/** One card: the artwork, the badge as a wordmark, every named defect, every abstention. */
function renderCard(record, template) {
  const notMeasured = record.notMeasured.length
    ? `<div class="notmeasured">
        <h3>Not measured <span class="hint">&mdash; not the same as clean</span></h3>
        <ul>${record.notMeasured
          .map(
            (e) =>
              `<li><code>${esc(e.dimension)}</code> <span class="reason">${esc(e.reason)}</span><p>${esc(e.note)}</p></li>`,
          )
          .join('\n          ')}</ul>
      </div>`
    : `<div class="notmeasured all"><p>Every dimension measured this piece. That is a statement about the analysers, not a compliment.</p></div>`;

  const defects = record.issues.length
    ? `<ul class="defects">${record.issues
        .map((i) => {
          const where = i.rect
            ? `<span class="rect">at ${i.rect.x},${i.rect.y} ${i.rect.w}x${i.rect.h}</span>`
            : '<span class="rect">whole document</span>';
          return `<li>
            <div class="head"><code class="code">${esc(i.code)}</code>${i.dimensions
              .map((d) => `<span class="dim">${esc(d)}</span>`)
              .join('')}${i.blocking ? '<span class="blocking">blocks delivery</span>' : ''}</div>
            <div class="where">${where}</div>
            <p class="what">${esc(i.message)}</p>
            ${i.guidance ? `<p class="todo">${esc(i.guidance)}</p>` : ''}
            <p class="disp">${
              i.disposition === 'safe-repair-available'
                ? 'A safe, unambiguous repair exists for this code and is returned as ops; it is not applied here.'
                : 'No machine repair: this is a decision, not a lookup.'
            }</p>
          </li>`;
        })
        .join('\n        ')}</ul>`
    : `<p class="clean">No dimension named a defect in this piece. That means nothing was found, not that the piece is finished.</p>`;

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${esc(record.title)} &mdash; ${esc(BADGE)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark;
    --ink:#16181d; --muted:#5d6470; --line:#d6dae1; --bg:#fbfbfc; --card:#fff;
    --defect:#8a3324; --abstain:#6b5410; --ok:#2f5d3a; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e6e8ec; --muted:#9aa2b1; --line:#2c3038; --bg:#14161a; --card:#1b1e24;
            --defect:#e59283; --abstain:#d8bd6a; --ok:#86c39a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--ink);
         font:16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:60rem; margin:0 auto; }
  h1 { font-size:1.8rem; margin:0 0 .3rem; }
  h3 { font-size:.95rem; margin:1.25rem 0 .4rem; text-transform:uppercase; letter-spacing:.06em;
       color:var(--muted); }
  p { margin:.4rem 0; }
  code { font:.86em ui-monospace, SFMono-Regular, Menlo, monospace; }
  .lede { color:var(--muted); max-width:42rem; }
  .badge { display:inline-flex; align-items:center; gap:.5rem; border:1px solid var(--line);
           border-radius:999px; padding:.2rem .7rem; font-size:.8rem; color:var(--muted);
           margin:.6rem 0 1.2rem; }
  /* The glyph strip is the badge as a mark rather than as a sentence: eight hard-edged cells,
     because a badge that resamples is a badge that has been drawn into the art. */
  .badge .strip { display:inline-flex; }
  .badge .strip i { width:6px; height:6px; display:block; }
  .shot { display:flex; justify-content:center; background-color:#fff; background-image:
          linear-gradient(45deg,#dfe3e9 25%,transparent 25%),linear-gradient(-45deg,#dfe3e9 25%,transparent 25%),
          linear-gradient(45deg,transparent 75%,#dfe3e9 75%),linear-gradient(-45deg,transparent 75%,#dfe3e9 75%);
          background-size:16px 16px; background-position:0 0,0 8px,8px -8px,-8px 0;
          border:1px solid var(--line); border-radius:6px; padding:.75rem; }
  .shot img { width:100%; height:auto; image-rendering:pixelated; display:block; }
  .facts { display:flex; flex-wrap:wrap; gap:.4rem .9rem; font-size:.84rem; color:var(--muted); }
  .facts span { border:1px solid var(--line); border-radius:999px; padding:.1rem .6rem; }
  .hint { text-transform:none; letter-spacing:0; font-weight:400; font-size:.8rem; opacity:.8; }
  .dims ul { list-style:none; display:flex; flex-wrap:wrap; gap:.35rem; padding:0; margin:.35rem 0 0; }
  .dims li { font:.8rem ui-monospace, monospace; border:1px solid var(--line); border-radius:4px;
             padding:.1rem .45rem; color:var(--ok); }
  .notmeasured { border-left:3px solid var(--abstain); padding:.1rem 0 .1rem .8rem; margin:1rem 0 0; }
  .notmeasured.all { border-left-style:dashed; opacity:.8; }
  .notmeasured ul { margin:.3rem 0; padding-left:1.1rem; }
  .notmeasured li { margin-bottom:.45rem; font-size:.9rem; }
  .notmeasured .reason { font:.78rem ui-monospace, monospace; color:var(--abstain); }
  .notmeasured p { font-size:.86rem; color:var(--muted); margin:.1rem 0 0; }
  .defects { list-style:none; margin:.3rem 0 0; padding:0; }
  .defects > li { border-top:1px solid var(--line); padding:.6rem 0; }
  .defects > li:first-child { border-top:0; }
  .head { display:flex; flex-wrap:wrap; align-items:baseline; gap:.45rem; }
  .code { font-weight:700; color:var(--defect); font-size:.95rem; }
  .dim { font:.74rem ui-monospace, monospace; border:1px solid var(--line); border-radius:4px;
         padding:0 .4rem; color:var(--muted); }
  .blocking { font-size:.74rem; letter-spacing:.04em; text-transform:uppercase; color:var(--defect);
              border:1px solid currentColor; border-radius:4px; padding:0 .4rem; }
  .where { font:.8rem ui-monospace, monospace; color:var(--muted); margin-top:.1rem; }
  .what { font-size:.92rem; margin-top:.35rem; }
  .todo { font-size:.88rem; color:var(--muted); border-left:2px solid var(--line); padding-left:.7rem; }
  .disp { font-size:.8rem; color:var(--muted); font-style:italic; }
  .clean { font-size:.92rem; color:var(--muted); font-style:italic; }
  footer { color:var(--muted); font-size:.84rem; margin-top:2rem; }
  .refused { border-left:3px solid var(--defect); padding:.1rem 0 .1rem .8rem; color:var(--defect); }
</style>

<main>
  <h1>${esc(record.title)}</h1>
  <p class="lede">${esc(template.summary)}</p>

  <p class="badge" title="carried in the PNG's text chunks, not drawn into the pixels">
    <span class="strip">${badgeStrip()}</span>
    <span>made with ${esc(BADGE)}</span>
  </p>

  <div class="shot"><img src="${esc(record.image)}" width="${record.width}" height="${record.height}"
       alt="${esc(record.title)} rendered from ${esc(record.source)} by the engine"></div>

  <p class="facts">
    <span>${record.width}&times;${record.height}</span>
    <span>${record.layers} layer${record.layers === 1 ? '' : 's'}</span>
    <span>${record.frames} frame${record.frames === 1 ? '' : 's'}</span>
    <span>asset class: ${esc(record.assetClass)}</span>
    <span>template: ${esc(template.id)}</span>
  </p>

  <p>Rendered from <code>${esc(record.source)}</code> by <code>export_png</code>. The badge above is
     drawn on this page only: the PNG carries it as a text chunk, so every pixel in
     <code>${esc(record.image)}</code> is the engine's, and decoding that file gives the artwork
     back unchanged.</p>

  <div class="dims"><span class="hint">dimensions that measured this piece</span>
    <ul>${record.measuredDimensions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>

  ${notMeasured}

  <div class="judgement">
    <h3>Named defects <span class="hint">&mdash; ${record.issues.length} found</span></h3>
    ${defects}
  </div>

  ${
    record.delivery
      ? `<div class="delivery"><h3>Delivery</h3>${
          record.delivery.refused
            ? `<p class="refused">The delivery gate refused this bundle and wrote no contract: ${esc(
                record.delivery.reason,
              )}</p>`
            : `<p>The asset contract and its engine files are in this bundle. The hash the PNG's text chunk names is the one in <code>meta.json</code>.</p>`
        }</div>`
      : ''
  }

  <footer>
    <p>Built by <code>node scripts/build-share.mjs</code> through the advertised MCP tool surface.
       Reproduce with <code>node scripts/build-share.mjs --verify</code>.</p>
  </footer>
</main>
</html>
`;
}

/**
 * The badge as a glyph strip: eight hard-edged cells, alternating, in the ink colour.
 *
 * Generated rather than checked in as an asset so it is byte-reproducible with no file to drift,
 * and hard-edged rather than antialiased because the point of a mark that claims to be made of
 * pixels is that it is made of pixels.
 */
function badgeStrip() {
  const ink = '#16181d';
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(`<i style="background:${i % 3 === 2 ? 'transparent' : ink}"></i>`);
  }
  return out.join('');
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

async function build() {
  const templates = await loadTemplates();
  const wanted = process.argv.includes('--template')
    ? [process.argv[process.argv.indexOf('--template') + 1]]
    : templates.map((t) => t.id);
  const chosen = templates.filter((t) => wanted.includes(t.id));
  if (chosen.length !== wanted.length) {
    throw new Error(`no such template: ${wanted.filter((w) => !chosen.some((t) => t.id === w)).join(', ')}`);
  }

  const server = new Server();
  try {
    await server.start();
    const sources = await discover();
    const bundles = [];
    for (const template of chosen) {
      for (const source of sources) bundles.push(await buildPiece(server, template, source));
    }
    const index = {
      generatedBy: 'scripts/build-share.mjs',
      engine: {
        name: server.serverInfo.name ?? 'dotloom-mcp',
        version: server.serverInfo.version ?? '0.0.0',
      },
      dimensions: DIMENSIONS,
      templates: chosen.map((t) => ({
        id: t.id,
        title: t.title,
        summary: t.summary,
        card: t.card,
        assetContract: t.assetContract === true,
        engine: t.engine ?? null,
        outputs: t.outputs.map((o) => o.type).sort(),
      })),
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
    process.stdout.write(`${t.id.padEnd(10)} ${t.outputs.map((o) => o.type).join('+').padEnd(28)} ${t.summary}\n`);
  }
} else {
  try {
    const index = await build();
    process.stdout.write(`share: ${index.bundles.length} bundle(s) across ${index.templates.length} template(s)\n`);
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
        process.stdout.write(`  verified: a second generation produced byte-identical output for ${names.length} file(s)\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
