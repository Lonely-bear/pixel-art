/**
 * `build-gallery` - generate the public gallery page at build time.
 *
 * `showcase-build.mjs` replays a *recipe* and writes a piece's outputs. This does the other
 * half: it walks the artwork that is already committed to this repository, opens each `.pixel`
 * through the advertised MCP tool surface, renders it through the engine, asks the judgement
 * layer what it can say about it, and writes one self-contained HTML page.
 *
 * Three commitments, and each of them is enforced by `packages/core/test/gallery.test.ts`
 * rather than asserted here in prose:
 *
 *   1. **Every piece is rendered from its `.pixel` source through the engine.** Never from the
 *      checked-in `.png` next to it. A gallery whose pictures can drift from the artwork they
 *      claim to show is worse than no gallery, and the engine is right there: `open_document`
 *      then `export_png`, both advertised tools, no library import. The committed `.png` files
 *      in `artwork/` are deliberately *not* read by this script.
 *
 *   2. **Pieces are discovered, not listed.** Every `.pixel` under `artwork/` (recursively) plus
 *      every `showcase/<piece>/<piece>.pixel`, sorted, so a new committed piece appears without
 *      editing this file. The only hand-written table is `CAPTIONS`, and a piece with no entry
 *      in it still gets a card.
 *
 *   3. **No score, grade, rating or percentage anywhere**, in the JSON or the HTML. A number
 *      handed to a reader becomes the target instead of the artwork; a `quality_report` tool was
 *      deleted in 0.3.1 because a model told the number was "clean" sanded a lake into a dark
 *      flat rectangle (see `AGENTS.md`). What the page carries instead is the **named** defects -
 *      the code, the dimension that found it, the region, and what to do about it - which is the
 *      form that stays actionable after the reader has thrown the number away.
 *
 * **An excluded dimension is not a clean dimension.** `ExcludedReason` is the reason a
 * dimension abstained, and the page renders every abstention in its own block, labelled *not
 * measured*, with the reason spelled out. It is never folded into the measured list and never
 * given a "clean" mark, because the two claims are different: "nothing wrong here" and "nobody
 * looked" both arrive as an absent number, and only one of them is a compliment.
 *
 * ## Determinism
 *
 * The page is a build artifact, so the same repository must produce the same bytes: no clock, no
 * randomness, no locale-dependent formatting, no session ids, and every collection sorted by an
 * explicit key. What the page shows is the artwork and the named defects, both of which are pure
 * functions of the committed `.pixel` files. `gallery.json` records each PNG's sha256 so a diff
 * shows a real change when the artwork changed and nothing at all when it did not.
 *
 * ## Usage
 *
 * ```bash
 * node scripts/build-gallery.mjs              # write showcase/gallery/
 * node scripts/build-gallery.mjs --verify     # generate twice and byte-compare
 * node scripts/build-gallery.mjs --check-coverage   # every discovered piece must be on the page
 * ```
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(root, 'packages', 'mcp', 'dist', 'cli.js');
const galleryRoot = resolve(root, 'showcase', 'gallery');
/** The gallery's path as git spells it, which is always forward-slashed and repo-relative. */
const relativeGallery = 'showcase/gallery';

const PROTOCOL_VERSION = '2025-06-18';

/**
 * How large a rendered piece is upscaled to, in pixels on its long side.
 *
 * A 32x32 sprite at 1:1 is a postage stamp next to a 512x512 environment, so small canvases get
 * an integer upscale. An integer, because a fractional scale would resample the artwork - the
 * page's job is to show the pixels the engine holds, not to smooth them.
 */
const TARGET_LONG_SIDE = 256;

/** The dimension set, in pipeline order, for the page's legend. */
const DIMENSIONS = ['silhouette', 'value', 'palette', 'noise', 'outline', 'motion'];

/**
 * Why a dimension abstained, in words a reader can act on.
 *
 * Every one of these is a statement about **this document**, never about the build. `no-outline`
 * in particular is the one a reader is most likely to misread as a fault: §4.5 says a document
 * with no drawn contour is a legitimate style, so the engine abstains rather than scoring it.
 * The page says so, because an abstention rendered as a tick would be the exact error this
 * repository has already made once.
 */
const EXCLUSION_NOTES = {
  'no-subject':
    'the ink runs to the frame on every edge, so the alpha boundary *is* the canvas and there is no shape to read. Measured on a different canvas, not on a different drawing.',
  'no-outline':
    'this document declares no drawn contour. That is a legitimate style - §4.5 calls it neutral, not bad - so the dimension abstains rather than scoring it.',
  'single-frame': 'the evaluated sequence is one frame, so there is nothing to measure motion across.',
  'no-motion-content':
    'every frame is byte-identical, so there is no motion to measure. An honest analyser asked to score this would return its best possible reading for a sprite that does not move; abstaining is the only truthful answer.',
  'not-implemented':
    'this build has no analyser for this dimension. That is a claim about the engine, not about the artwork.',
};

/**
 * Optional hand-written captions, keyed by piece id.
 *
 * **Optional on purpose.** A piece with no entry still gets a card, a derived from the id; this
 * table adds the sentence a reader actually wants and nothing structural depends on it.
 */
const CAPTIONS = {
  'ironhold-knight':
    'Armoured hero, drawn through the advertised tool surface alone: cape, tabard, shouldered greatsword. Ships with its full recipe in `ops.json`.',
  'verify/lantern-keeper':
    'The only real character sprite in this repository, and the piece that proved the lazy tool surface: it was drawn by an agent that started with no drawing commands at all and found them through `list_commands`.',
  'autumn-dusk-lake-256':
    'A 256x256 environment. Full-bleed, so it has no subject to read a silhouette or a contour from - and the page says so rather than showing an empty column.',
  'dusk-lake-valley':
    'An environment, revised over four critique passes. The later passes are listed beside it rather than replacing it, because the differences between them are the interesting part.',
  'moonlit-alpine-lake':
    'A deliberately small and fast pass: the whole pass, at low cost, in a single document.',
  'sunset-lighthouse-512':
    'The largest piece here, 512x512.',
};

/** Derive a title from an id, so an uncaptioned piece is still labelled. */
function titleFromId(id) {
  const last = id.split('/').pop() ?? id;
  return last
    .replace(/-\d+x\d+$/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** A filesystem-safe slug for a piece id (`verify/lantern-keeper` -> `verify--lantern-keeper`). */
function slugFor(id) {
  return id.replace(/[^\w.-]+/g, '--');
}

/** Escape text for HTML text and double-quoted attribute context. */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Collapse an analyzer's prose onto one line. Deterministic, and it keeps the HTML readable. */
function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ the MCP client

/**
 * A raw JSON-RPC client over stdio, deliberately the same shape as `showcase-build.mjs` and
 * `mcp-call.mjs`: this script imports nothing from `@pixel/core` and reaches the engine only
 * through `tools/call`, so a card on the page is evidence about the *product* and not about a
 * library shortcut.
 */
class Server {
  constructor() {
    // `cwd: root` so every `path` in this script resolves against the repository root no matter
    // where the build was invoked from.
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
      clientInfo: { name: 'build-gallery', version: '1.0.0' },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    this.serverInfo = result.serverInfo ?? {};
    return result;
  }

  stop() {
    this.child.kill();
  }

  /** Call one advertised tool and decode its envelope, throwing on a reported failure. */
  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    const block = (result?.content ?? []).find((b) => b.type === 'text');
    let payload = null;
    try {
      payload = block ? JSON.parse(block.text) : null;
    } catch {
      payload = null;
    }
    if (result?.isError || payload?.ok === false) {
      throw new Error(`${name} -> ${payload?.error ?? JSON.stringify(payload ?? result)}`);
    }
    return payload;
  }
}

// ------------------------------------------------------------------ discovery

/**
 * Every committed piece, discovered rather than listed.
 *
 * Every `.pixel` under `artwork/`, recursively (which is where the environments and the character
 * sprite live), plus `showcase/<piece>/<piece>.pixel` (where the recipe-driven pieces live).
 * Sorted by id, because an incidental `readdir` order is a diff.
 */
async function discover() {
  const found = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const item of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.name.endsWith('.pixel')) {
        found.push(relative(root, full).split(sep).join('/'));
      }
    }
  }

  await walk(resolve(root, 'artwork'));
  for (const item of (await readdir(resolve(root, 'showcase'), { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (!item.isDirectory()) continue;
    const candidate = join('showcase', item.name, `${item.name}.pixel`);
    try {
      await readFile(resolve(root, candidate));
      found.push(candidate.split(sep).join('/'));
    } catch {
      // A showcase directory without a `.pixel` of its own is not a piece.
    }
  }

  // Deduplicated and sorted, on the full repository-relative path so the order is a property of
  // the tree rather than of a hash set. `renderPiece` is what derives the shorter card id.
  return [...new Set(found)].sort();
}

// ------------------------------------------------------------------ one piece

/**
 * Open, render and judge one piece.
 *
 * Four advertised tool calls, in this order and no others:
 *   `open_document` -> the `.pixel`, through the engine's own deserialiser
 *   `get_document`  -> the canvas facts, for the card's caption
 *   `export_png`    -> the image, through the engine's own rasteriser and PNG writer
 *   `evaluate`      -> the named defects and the abstentions
 *   `apply_ops`     -> one `fix` op, for the "what to do" line
 *
 * **Nothing here reads a `.png` from disk**, and `export_png` writes into `showcase/gallery/out/`
 * rather than over `artwork/`, so a build cannot quietly rewrite the artwork it is displaying.
 */
async function renderPiece(server, sourcePath) {
  // The card id drops the folder a piece lives in, because it is a label rather than a path:
  // `artwork/verify/lantern-keeper.pixel` -> `verify/lantern-keeper`. The full source path is
  // carried separately, on `source`.
  const id = sourcePath.startsWith('artwork/')
    ? sourcePath.slice('artwork/'.length).replace(/\.pixel$/, '')
    : sourcePath.replace(/^showcase\//, '').replace(/\/[^/]+\.pixel$/, '');
  const slug = slugFor(id);

  await server.call('open_document', { path: sourcePath });
  const info = await server.call('get_document');
  const doc = info.document;

  const scale = Math.max(1, Math.min(8, Math.floor(TARGET_LONG_SIDE / Math.max(doc.width, doc.height))));
  const imagePath = `showcase/gallery/out/${slug}.png`;
  await server.call('export_png', { out: imagePath, scale });

  const judgement = await server.call('evaluate', {});
  // `fix` is a core command, reached through `apply_ops` exactly as an agent would reach it. It
  // is readOnly: it returns ops *as data* and runs nothing.
  const plan = await server.call('apply_ops', { ops: [{ command: 'fix', params: {} }] });
  const plans = plan.results?.[0]?.summary?.plans ?? [];
  const byCode = new Map(plans.map((p) => [p.code, p]));

  const png = await readFile(resolve(root, imagePath));

  // Sorted by code so the order is a property of the data rather than of a hash map, and one
  // entry per issue regardless of how many dimensions reported it.
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
      // `fix` declines most codes on purpose: a fix that guesses is worse than one that says
      // what a person has to decide. `disposition` records which happened.
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

  // `unmeasured` names the *sub-scores* a present dimension could not take, read off each
  // measured dimension rather than off the envelope's flattened copy. Folded into the same "not
  // measured" block as a whole-dimension exclusion, because to a reader they are the same fact:
  // part of this claim was not checked.
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

  return {
    id,
    slug,
    title: titleFromId(id),
    caption: CAPTIONS[id] ?? `${titleFromId(id)}, ${doc.width}x${doc.height}.`,
    source: sourcePath,
    width: doc.width,
    height: doc.height,
    layers: doc.layerCount,
    frames: doc.frameCount,
    image: `out/${slug}.png`,
    imageBytes: png.length,
    imageSha256: createHash('sha256').update(png).digest('hex'),
    assetClass: judgement.assetClass?.cls ?? judgement.report?.assetClass?.cls ?? 'unknown',
    measuredDimensions: [...(judgement.measuredDimensions ?? [])].sort(),
    notMeasured: [...excluded, ...partial].sort((a, b) =>
      a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0,
    ),
    issues,
  };
}

// ------------------------------------------------------------------ the page

/** One card: the render, then every named defect, then every abstention. */
function card(piece) {
  const notMeasured = piece.notMeasured.length
    ? `<div class="notmeasured">
        <h3>Not measured <span class="hint">&mdash; not the same as clean</span></h3>
        <ul>${piece.notMeasured
          .map(
            (entry) =>
              `<li><code>${esc(entry.dimension)}</code> <span class="reason">${esc(entry.reason)}</span><p>${esc(entry.note)}</p></li>`,
          )
          .join('\n          ')}</ul>
      </div>`
    : `<div class="notmeasured all">
        <p>Every dimension measured this piece. That is a statement about the analysers, not a compliment.</p>
      </div>`;

  const defects = piece.issues.length
    ? `<ul class="defects">${piece.issues
        .map((issue) => {
          const rect = issue.rect
            ? `<span class="rect">at ${issue.rect.x},${issue.rect.y} ${issue.rect.w}x${issue.rect.h}</span>`
            : '<span class="rect">whole document</span>';
          const guidance = issue.guidance ? `<p class="todo">${esc(issue.guidance)}</p>` : '';
          return `<li>
            <div class="head"><code class="code">${esc(issue.code)}</code>${
              issue.dimensions.map((d) => `<span class="dim">${esc(d)}</span>`).join('')
            }${issue.blocking ? '<span class="blocking">blocks delivery</span>' : ''}</div>
            <div class="where">${rect}</div>
            <p class="what">${esc(issue.message)}</p>
            ${guidance}
            <p class="disp">${
              issue.disposition === 'safe-repair-available'
                ? 'A safe, unambiguous repair exists for this code and is returned as ops; it is not applied here.'
                : 'No machine repair: this is a decision, not a lookup.'
            }</p>
          </li>`;
        })
        .join('\n        ')}</ul>`
    : `<p class="clean">No dimension named a defect in this piece. That means nothing was found, not that the piece is finished.</p>`;

  return `<figure class="piece" id="${esc(piece.id)}">
  <div class="shot"><img src="${esc(piece.image)}" width="${piece.width}" height="${piece.height}" alt="${esc(piece.title)} rendered from ${esc(piece.source)} by the engine" loading="lazy"></div>
  <figcaption>
    <h2>${esc(piece.title)}</h2>
    <p class="caption">${esc(piece.caption)}</p>
    <p class="facts">
      <span>${piece.width}&times;${piece.height}</span>
      <span>${piece.layers} layer${piece.layers === 1 ? '' : 's'}</span>
      <span>${piece.frames} frame${piece.frames === 1 ? '' : 's'}</span>
      <span>asset class: ${esc(piece.assetClass)}</span>
    </p>
    <p class="src">rendered from <code>${esc(piece.source)}</code> by <code>export_png</code> &mdash;
      sha256 <code>${esc(piece.imageSha256.slice(0, 16))}</code></p>
    <div class="dims"><span class="hint">dimensions that measured this piece</span>
      <ul>${piece.measuredDimensions
        .map((d) => `<li>${esc(d)}</li>`)
        .join('')}</ul></div>
    ${notMeasured}
    <div class="judgement">
      <h3>Named defects <span class="hint">&mdash; ${piece.issues.length} found</span></h3>
      ${defects}
    </div>
  </figcaption>
</figure>`;
}

function renderPage(gallery) {
  const pieces = gallery.pieces.map(card).join('\n');
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>dotloom-mcp &mdash; gallery</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: light dark;
    --ink: #16181d; --muted: #5d6470; --line: #d6dae1; --bg: #fbfbfc; --card: #ffffff;
    --defect: #8a3324; --abstain: #6b5410; --ok: #2f5d3a;
  }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e6e8ec; --muted: #9aa2b1; --line: #2c3038; --bg: #14161a; --card: #1b1e24;
            --defect: #e59283; --abstain: #d8bd6a; --ok: #86c39a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.25rem 5rem; background: var(--bg); color: var(--ink);
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 68rem; margin: 0 auto; }
  h1 { font-size: 1.9rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.25rem; margin: 0 0 .35rem; }
  h3 { font-size: .95rem; margin: 1.25rem 0 .4rem; text-transform: uppercase; letter-spacing: .06em;
       color: var(--muted); }
  p { margin: .4rem 0; }
  code { font: .86em ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: inherit; }
  .lede { max-width: 44rem; color: var(--muted); }
  .rule { border: 0; border-top: 1px solid var(--line); margin: 2.5rem 0; }
  .legend { display: grid; gap: .9rem; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }
  .legend > div { border: 1px solid var(--line); border-radius: 8px; padding: .9rem 1rem; background: var(--card); }
  .legend h3 { margin-top: 0; }
  .legend p { font-size: .92rem; color: var(--muted); }
  .piece { display: grid; grid-template-columns: minmax(0, 22rem) minmax(0, 1fr); gap: 1.5rem;
           border: 1px solid var(--line); border-radius: 10px; background: var(--card);
           padding: 1.25rem; margin: 0 0 1.75rem; }
  @media (max-width: 46rem) { .piece { grid-template-columns: minmax(0, 1fr); } }
  .shot { align-self: start; display: flex; justify-content: center;
          background-color: #fff; background-image:
            linear-gradient(45deg, #dfe3e9 25%, transparent 25%), linear-gradient(-45deg, #dfe3e9 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #dfe3e9 75%), linear-gradient(-45deg, transparent 75%, #dfe3e9 75%);
          background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0;
          border: 1px solid var(--line); border-radius: 6px; padding: .75rem; }
  .shot img { width: 100%; height: auto; image-rendering: pixelated; display: block; }
  .caption { color: var(--muted); }
  .facts { display: flex; flex-wrap: wrap; gap: .4rem .9rem; font-size: .84rem; color: var(--muted);
           margin: .7rem 0 .2rem; }
  .facts span { border: 1px solid var(--line); border-radius: 999px; padding: .1rem .6rem; }
  .src { font-size: .8rem; color: var(--muted); }
  .hint { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: .8rem; opacity: .8; }
  .dims ul { list-style: none; display: flex; flex-wrap: wrap; gap: .35rem; padding: 0; margin: .35rem 0 0; }
  .dims li { font: .8rem ui-monospace, monospace; border: 1px solid var(--line); border-radius: 4px;
             padding: .1rem .45rem; color: var(--ok); }
  .notmeasured { border-left: 3px solid var(--abstain); padding: .1rem 0 .1rem .8rem; margin: 1rem 0 0; }
  .notmeasured.all { border-left-style: dashed; opacity: .8; }
  .notmeasured ul { margin: .3rem 0; padding-left: 1.1rem; }
  .notmeasured li { margin-bottom: .45rem; font-size: .9rem; }
  .notmeasured .reason { font: .78rem ui-monospace, monospace; color: var(--abstain); }
  .notmeasured p { font-size: .86rem; color: var(--muted); margin: .1rem 0 0; }
  .defects { list-style: none; margin: .3rem 0 0; padding: 0; }
  .defects > li { border-top: 1px solid var(--line); padding: .6rem 0; }
  .defects > li:first-child { border-top: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .45rem; }
  .code { font-weight: 700; color: var(--defect); font-size: .95rem; }
  .dim { font: .74rem ui-monospace, monospace; border: 1px solid var(--line); border-radius: 4px;
         padding: 0 .4rem; color: var(--muted); }
  .blocking { font-size: .74rem; letter-spacing: .04em; text-transform: uppercase; color: var(--defect);
              border: 1px solid currentColor; border-radius: 4px; padding: 0 .4rem; }
  .where { font: .8rem ui-monospace, monospace; color: var(--muted); margin-top: .1rem; }
  .what { font-size: .92rem; margin-top: .35rem; }
  .todo { font-size: .88rem; color: var(--muted); border-left: 2px solid var(--line); padding-left: .7rem; }
  .disp { font-size: .8rem; color: var(--muted); font-style: italic; }
  .clean { font-size: .92rem; color: var(--muted); font-style: italic; }
  footer { color: var(--muted); font-size: .84rem; max-width: 44rem; }
  footer code { word-break: break-all; }
</style>

<main>
  <h1>dotloom-mcp gallery</h1>
  <p class="lede">Every committed piece of artwork in this repository, rendered from its
  <code>.pixel</code> source by the engine and published next to what the judgement layer can
  say about it. Nothing here is a hand-placed screenshot: each image on this page came out of
  <code>export_png</code> during this build, and each name, code and region came out of
  <code>evaluate</code>.</p>

  <hr class="rule">

  <h2>How to read this page</h2>
  <div class="legend">
    <div>
      <h3>Named defects, never a number</h3>
      <p>Every problem on this page is a <strong>code</strong>, the <strong>dimension</strong> that
      found it, the <strong>region</strong> it sits in and the <strong>what to do</strong> line
      beneath it. That is the whole form on purpose. A single number handed to a reader becomes the
      target instead of the artwork: this repository once shipped a tool that returned one, a model
      was told a lake was clean, and the model sanded the lake into a dark flat rectangle to keep it
      clean. Names survive being ignored; a number does not.</p>
    </div>
    <div>
      <h3>Not measured is not clean</h3>
      <p>A dimension can abstain: a full-bleed scene has no subject to read a silhouette from,
      and a document that declares no outline is choosing a style rather than failing one. Those
      abstentions are printed in their own <strong>Not measured</strong> block, never folded into
      the list of things that were checked. An absent measurement and a good result both arrive as
      a missing number, and only one of them is a compliment.</p>
    </div>
    <div>
      <h3>The dimensions</h3>
      <p>${DIMENSIONS.map(
        (d) => `<code>${d}</code>`,
      ).join(', ')} &mdash; each reports per-dimension findings, and the ones that could not run on
      a given piece say why. The weighted total exists internally for the delivery gate and is
      deliberately not on this page.</p>
    </div>
  </div>

  <hr class="rule">

${pieces}

  <hr class="rule">
  <footer>
    <p>Built by <code>node scripts/build-gallery.mjs</code> through the advertised MCP tool surface
    only &mdash; <code>open_document</code>, <code>get_document</code>, <code>export_png</code>,
    <code>evaluate</code> and one <code>fix</code> through <code>apply_ops</code>. No
    <code>@pixel/core</code> import, and the checked-in <code>.png</code> files beside each source
    are not read. Generated with ${esc(gallery.engine.name)} ${esc(gallery.engine.version)}.</p>
    <p>${gallery.pieces.length} pieces, ${gallery.pieces.reduce(
      (n, p) => n + p.issues.length,
      0,
    )} named defects, ${gallery.pieces.reduce((n, p) => n + p.notMeasured.length, 0)} abstentions.
    Reproduce with <code>node scripts/build-gallery.mjs --verify</code>.</p>
  </footer>
</main>
</html>
`;
}

// ------------------------------------------------------------------ the build

/**
 * sha256 of what this run just wrote, keyed by path relative to the gallery root.
 * The mirror of {@link committedHashes}, and the two are compared directly.
 */
async function writtenHashes() {
  const out = new Map();
  for (const name of ['index.html', 'gallery.json']) {
    out.set(name, await sha256File(join(galleryRoot, name)));
  }
  for (const [name, hash] of Object.entries(await snapshotOut())) out.set(`out/${name}`, hash);
  return out;
}

/**
 * sha256 of the gallery as it is COMMITTED, keyed the same way.
 *
 * `git show HEAD:<path>` rather than reading the working tree, so an artifact that was hand-edited
 * and not committed is caught as stale — which is the whole point. `git ls-tree` names the files
 * that are tracked at all, so a PNG that exists on disk but was never committed is also caught,
 * from the other direction: it is in `writtenHashes` and absent here.
 */
async function committedHashes() {
  const out = new Map();
  const listed = await git(['ls-tree', '-r', '--name-only', 'HEAD', '--', relativeGallery]);
  for (const line of listed.split('\n')) {
    const name = line.trim();
    if (name === '' || !name.startsWith(`${relativeGallery}/`)) continue;
    const bytes = await git(['show', `HEAD:${name}`], { binary: true });
    out.set(name.slice(relativeGallery.length + 1), createHash('sha256').update(bytes).digest('hex'));
  }
  return out;
}

/** Run git in the repository, returning stdout. `binary` skips the text decoding for `git show`. */
function git(args, { binary = false } = {}) {
  const run = spawnSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${run.status}): ${run.stderr ?? ''}`);
  }
  return binary ? run.stdout : String(run.stdout ?? '');
}
async function writeGallery(gallery) {
  // `out/` is NOT cleared here: `export_png` has already written into it during this build, and
  // clearing it would delete the renders the page is about to reference. A stale PNG left by a
  // piece that has since been deleted is harmless, because the page only ever references the
  // files this build wrote.
  await writeFile(join(galleryRoot, 'gallery.json'), `${JSON.stringify(gallery, null, 2)}\n`);
  await writeFile(join(galleryRoot, 'index.html'), renderPage(gallery));
  return ['index.html', 'gallery.json'];
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function snapshotOut() {
  const files = {};
  for (const name of (await readdir(join(galleryRoot, 'out'))).sort()) {
    files[name] = await sha256File(join(galleryRoot, 'out', name));
  }
  return files;
}

/** One generation: discover, render every piece, write the page. */
async function build() {
  const server = new Server();
  try {
    await server.start();
    const sources = await discover();
    const pieces = [];
    for (const source of sources) pieces.push(await renderPiece(server, source));
    const gallery = {
      generatedBy: 'scripts/build-gallery.mjs',
      engine: { name: server.serverInfo.name ?? 'dotloom-mcp', version: server.serverInfo.version ?? '0.0.0' },
      dimensions: DIMENSIONS,
      pieces,
    };
    await writeGallery(gallery);
    return gallery;
  } finally {
    server.stop();
  }
}

const verify = process.argv.includes('--verify');
const checkCoverage = process.argv.includes('--check-coverage');
const checkStale = process.argv.includes('--check-stale');

try {
  const first = await build();
  process.stdout.write(`gallery: ${first.pieces.length} piece(s)\n`);
  for (const piece of first.pieces) {
    process.stdout.write(
      `  ${piece.id.padEnd(34)} ${String(piece.width).padStart(4)}x${String(piece.height).padEnd(4)} ` +
        `${String(piece.issues.length).padStart(2)} defect(s)  ${piece.notMeasured.length} not measured\n`,
    );
  }

  if (checkCoverage) {
    // The anti-drift gate, and the reason pieces are *discovered* rather than listed: a
    // `.pixel` committed to `artwork/` must be on the page without anyone editing this file.
    // It reads the written `gallery.json` rather than the in-memory result, so it checks the
    // artifact rather than this run.
    const written = JSON.parse(await readFile(join(galleryRoot, 'gallery.json'), 'utf8'));
    const onPage = new Set(written.pieces.map((p) => p.source));
    const discovered = await discover();
    const missing = discovered.filter((source) => !onPage.has(source));
    if (missing.length) {
      process.stderr.write(`NOT COVERED: ${missing.join(', ')}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `  coverage: all ${discovered.length} discovered piece(s) are on the page\n`,
      );
    }
  }

  if (verify) {
    // Determinism is an acceptance criterion for a build artifact, so it is measured rather
    // than claimed: a second full generation, byte-compared against the first.
    const pageBefore = await sha256File(join(galleryRoot, 'index.html'));
    const jsonBefore = await sha256File(join(galleryRoot, 'gallery.json'));
    const pngBefore = await snapshotOut();
    await build();
    const pageAfter = await sha256File(join(galleryRoot, 'index.html'));
    const jsonAfter = await sha256File(join(galleryRoot, 'gallery.json'));
    const pngAfter = await snapshotOut();

    const drifted = [];
    if (pageBefore !== pageAfter) drifted.push('index.html');
    if (jsonBefore !== jsonAfter) drifted.push('gallery.json');
    for (const name of new Set([...Object.keys(pngBefore), ...Object.keys(pngAfter)])) {
      if (pngBefore[name] !== pngAfter[name]) drifted.push(`out/${name}`);
    }
    if (drifted.length) {
      process.stderr.write(`NOT REPRODUCIBLE: ${drifted.join(', ')}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `  verified: a second generation produced byte-identical output for ` +
          `${2 + Object.keys(pngBefore).length} file(s)\n`,
      );
    }
  }

  if (checkStale) {
    // **The gallery is COMMITTED, so it can go stale, and a stale gallery is worse than none.**
    //
    // Determinism above asks "does the same source produce the same bytes?". This asks the question
    // that actually matters to a reader: "are the committed bytes still what this source produces?".
    // `--verify` cannot see drift, because it regenerates into the very directory it then compares
    // against — it is self-consistent by construction and would happily agree with a gallery whose
    // artwork had changed three commits ago.
    //
    // The comparison is made from `git show HEAD:`, not from the working tree, so it also catches a
    // generated file that was edited by hand and left uncommitted. Work in flight is the one case
    // this cannot judge, which is why it is a flag and not unconditional: a session with an edited
    // `.pixel` will see this fail, and the fix is to regenerate and commit both together.
    const committed = await committedHashes();
    const fresh = await writtenHashes();
    const names = [...new Set([...committed.keys(), ...fresh.keys()])].sort();
    const stale = names.filter((name) => committed.get(name) !== fresh.get(name));
    if (stale.length > 0) {
      process.stderr.write(
        `STALE: showcase/gallery is committed but no longer matches what this source produces:\n` +
          stale.map((n) => `  ${n}\n`).join('') +
          `Run \`pnpm build:gallery\` and commit the result.\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`  gallery: committed output matches a fresh build (${names.length} file(s))\n`);
    }
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}