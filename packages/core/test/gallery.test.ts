import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The build-time gallery, `scripts/build-gallery.mjs` -> `showcase/gallery/`.
 *
 * This file guards four claims the gallery makes about itself. Each one is a claim that is
 * easy to state in a document and easy to stop being true, which is why each is measured here
 * rather than asserted in prose.
 *
 *   1. **The page is a build artifact, so it must be reproducible.** The script is run with
 *      `--verify`, which generates twice and byte-compares every output, and a non-zero exit
 *      here fails the suite. A clock, a session id or an incidental `readdir` order leaking into
 *      the page would show up as a diff in every commit, which is the cheapest possible
 *      determinism test there is.
 *
 *   2. **Every committed piece is on it, and a new one appears without editing the
 *      generator.** Pieces are *discovered* (`artwork/` recursively plus `showcase/<piece>/`),
 *      and `--check-coverage` re-walks the tree and fails on anything missing. That is the
 *      mechanism that stops the gallery drifting behind the artwork; a hand-maintained list
 *      would be the failure mode this replaces.
 *
 *   3. **No score anywhere.** `AGENTS.md` records the most expensive lesson in this repository:
 *      a `quality_report` tool was deleted in 0.3.1 because a model was told a number was
 *      "clean" and sanded a lake into a dark flat rectangle. The walk below is the same one
 *      `packages/cli/test/contract.test.ts` and `packages/app/src/asset-bundle.test.tsx` use -
 *      it collects every **key name** recursively, because the number is the thing that must
 *      not exist, and a nested `score` cannot hide from it. The HTML gets the same treatment
 *      over its own text, which is why the page's prose is worded to avoid the vocabulary
 *      rather than relying on a whitelist.
 *
 *   4. **An excluded dimension is not rendered as a clean one.** `ExcludedReason` exists
 *      because "nothing wrong here" and "nobody looked" both arrive as an absent number, and
 *      only one of them is a compliment. The assertion below is on a real piece
 *      (`autumn-dusk-lake-256`, a full-bleed scene): `silhouette` and `outline` abstain with
 *      `no-subject`, so they must appear under *not measured* with the reason spelled out, and
 *      must **not** appear in the list of dimensions that measured the piece. A page that
 *      rendered an abstention as a tick would be repeating the exact error T-099 already made
 *      once, and this is what makes that checkable rather than aspirational.
 *
 * The build needs `packages/mcp/dist/cli.js`, so `pnpm build:libs` is a prerequisite - the
 * usual trap documented in `AGENTS.md`. It is spawned as a child process rather than imported,
 * because the script reaches the engine only through the advertised MCP tool surface and a test
 * that imported `@pixel/core` beside it would not be testing the same thing.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'build-gallery.mjs');
const galleryRoot = join(repoRoot, 'showcase', 'gallery');

/**
 * Twelve pieces, each a fresh MCP server, twice over, plus a render each. Generous, because a
 * cold CI runner is slower than a warm laptop and an intermittent timeout here would be read as
 * a flake rather than as the 6 seconds it actually costs. `AGENTS.md` has already been bitten by
 * three 5-second timeouts in this repository.
 */
const BUILD_TIMEOUT = 180_000;

let stdout = '';
let stderr = '';
let status: number | null = null;
let gallery: Gallery;
let page: string;

interface GalleryIssue {
  code: string;
  dimensions: string[];
  rect: { x: number; y: number; w: number; h: number } | null;
  blocking: boolean;
  message: string;
  disposition: string;
  guidance: string | null;
}
interface GalleryPiece {
  id: string;
  slug: string;
  title: string;
  caption: string;
  source: string;
  width: number;
  height: number;
  layers: number;
  frames: number;
  image: string;
  imageBytes: number;
  imageSha256: string;
  assetClass: string;
  measuredDimensions: string[];
  notMeasured: { dimension: string; reason: string; note: string }[];
  issues: GalleryIssue[];
}
interface Gallery {
  generatedBy: string;
  engine: { name: string; version: string };
  dimensions: string[];
  pieces: GalleryPiece[];
}

/**
 * Recursively collect every key name in a value, so a nested `score` cannot hide.
 * The same walk `packages/cli/test/contract.test.ts` uses: names, not values, because the
 * number is the thing that must not exist.
 */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, i) => keyPaths(entry, `${prefix}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
      `${prefix}.${key}`,
      ...keyPaths(entry, `${prefix}.${key}`),
    ]);
  }
  return [];
}

const FORBIDDEN = /score|grade|rating|percent|quality|verdict/i;

function piece(id: string): GalleryPiece {
  const found = gallery.pieces.find((p) => p.id === id);
  if (!found) throw new Error(`no piece "${id}" on the page; ids are ${gallery.pieces.map((p) => p.id).join(', ')}`);
  return found;
}

/** The `<figure>` block for one piece, so an assertion is about that card and not the whole page. */
function card(id: string): string {
  const at = page.indexOf(`<figure class="piece" id="${id}">`);
  expect(at, `no <figure> for "${id}"`).toBeGreaterThan(-1);
  const end = page.indexOf('</figure>', at);
  return page.slice(at, end);
}

beforeAll(() => {
  const run = spawnSync(process.execPath, [script, '--verify', '--check-coverage'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  stdout = run.stdout ?? '';
  stderr = run.stderr ?? '';
  status = run.status;
  if (!existsSync(join(galleryRoot, 'gallery.json'))) {
    throw new Error(`the gallery script produced nothing:\n${stdout}\n${stderr}`);
  }
  gallery = JSON.parse(readFileSync(join(galleryRoot, 'gallery.json'), 'utf8')) as Gallery;
  page = readFileSync(join(galleryRoot, 'index.html'), 'utf8');
}, BUILD_TIMEOUT);

describe('the gallery builds', () => {
  it('reproduces byte for byte, and says so', () => {
    // The script's own `--verify` did the two generations and the byte comparison. Asserting
    // its verdict rather than repeating it here keeps the expensive part in one place, and a
    // regression in the page's bytes cannot pass by failing to mention it.
    expect(`${stdout}${stderr}`).toContain('verified: a second generation produced byte-identical output');
    expect(status, `${stdout}\n${stderr}`).toBe(0);
  }, BUILD_TIMEOUT);

  it('puts every committed piece on the page without the generator listing them', () => {
    // `--check-coverage` re-walks `artwork/` and `showcase/` and fails on anything missing, so
    // this passing means the page was generated from the tree, not from a hand-maintained list.
    expect(stdout).toMatch(/coverage: all \d+ discovered piece\(s\) are on the page/);
    const ids = gallery.pieces.map((p) => p.id);
    // The four families the repository actually committed, across both sources.
    for (const expected of [
      'verify/lantern-keeper',
      'ironhold-knight',
      'autumn-dusk-lake-256',
      'sunset-lighthouse-512',
    ]) {
      expect(ids, `${expected} should be on the page`).toContain(expected);
    }
    // Ordered by source path - `artwork/` then `showcase/` - because an incidental `readdir`
    // order is a diff. The page's card ids are a shortening of that path, not the sort key.
    const sources = gallery.pieces.map((p) => p.source);
    expect([...sources].sort()).toEqual(sources);
  }, BUILD_TIMEOUT);

  it('renders every image from the .pixel source rather than from a checked-in PNG', () => {
    // Positive half: each `imageSha256` is the hash of the file the page points at, so the page
    // cannot drift from the render. Negative half: the generator never reads a `.png` at all, so
    // the render can only have come out of `export_png`. The committed PNGs beside each source
    // are read by nothing here.
    for (const p of gallery.pieces) {
      const onDisk = readFileSync(join(galleryRoot, p.image));
      expect(createHash('sha256').update(onDisk).digest('hex'), `${p.id} image hash`).toBe(p.imageSha256);
      expect(p.image).toMatch(/^out\//);
      expect(p.source.endsWith('.pixel'), `${p.id} should name a .pixel source`).toBe(true);
    }
    const source = readFileSync(script, 'utf8');
    expect(
      source.split('\n').filter((line) => /readFile/.test(line) && /\.png/.test(line)),
      'the generator must not read a .png',
    ).toEqual([]);
  }, BUILD_TIMEOUT);
});

describe('the gallery publishes no score', () => {
  it('puts no such key in gallery.json', () => {
    // The walk is over key *names*, recursively, because `evaluate` returns `score` and
    // `scoreQ` on every dimension and copying one field would be enough to reintroduce the
    // thing that was deleted in 0.3.1.
    for (const keyPath of keyPaths(gallery)) {
      expect(FORBIDDEN.test(keyPath), `${keyPath} looks like a verdict`).toBe(false);
    }
  }, BUILD_TIMEOUT);

  it('names no such thing in the page text', () => {
    // No whitelist and no disclaimer carve-out: the page's prose is written to avoid the
    // vocabulary altogether, so this holds over the whole document including the part that
    // explains why the numbers are absent. A reader (or a model) skimming the page must not be
    // able to find a number to move toward, even accidentally.
    const hits = page
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => FORBIDDEN.test(line))
      .map(({ line, index }) => `${index + 1}: ${line.trim()}`);
    expect(hits).toEqual([]);
  }, BUILD_TIMEOUT);
});

describe('an abstention is not a pass', () => {
  // `autumn-dusk-lake-256` is a full-bleed 256x256 scene, which is the case this repository has
  // already got wrong once: `silhouette` was confidently reporting a blocking `shape-clipped`
  // on all ten of the full-bleed artworks because the alpha boundary of a scene *is* the canvas.
  // It abstains now, with `no-subject`, and the page has to say so rather than tick a box.
  const scene = 'autumn-dusk-lake-256';

  it('carries the ExcludedReason and its explanation', () => {
    const p = piece(scene);
    const abstained = p.notMeasured.filter((n) => n.reason === 'no-subject');
    expect(abstained.map((n) => n.dimension).sort()).toEqual(['outline', 'silhouette']);
    for (const entry of abstained) {
      expect(entry.note.length, `${entry.dimension} must explain itself`).toBeGreaterThan(40);
    }
  }, BUILD_TIMEOUT);

  it('does not also claim those dimensions measured the piece', () => {
    const p = piece(scene);
    for (const entry of p.notMeasured) {
      expect(p.measuredDimensions, `${entry.dimension} is in both blocks`).not.toContain(entry.dimension);
    }
    // The abstentions are not empty for every piece either: the character sprite and the
    // recipe-driven knight are single-frame, so `motion` abstains there too.
    expect(piece('verify/lantern-keeper').notMeasured.map((n) => n.reason)).toContain('single-frame');
  }, BUILD_TIMEOUT);

  it('renders the abstention as "not measured", on the page, for that piece only', () => {
    const html = card(scene);
    expect(html).toContain('Not measured');
    expect(html).toContain('not the same as clean');
    expect(html).toContain('no-subject');
    expect(html).toContain('<code>silhouette</code>');
    // And it is absent from the block that lists what did measure the piece.
    const measured = /dimensions that measured this piece<\/span>\s*<ul>(.*?)<\/ul>/s.exec(html);
    expect(measured, 'no measured-dimensions block').not.toBeNull();
    expect(measured?.[1]).not.toContain('silhouette');
  }, BUILD_TIMEOUT);
});

describe('a defect is named, located and actionable', () => {
  // `verify/lantern-keeper` is the repository's only real character sprite and it carries real
  // findings, so it is the piece the "named defect" claim is checked against.
  const sprite = 'verify/lantern-keeper';

  it('names every issue with a code, a dimension, a region and what to do', () => {
    const issues = piece(sprite).issues;
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.code, 'every issue carries a stable code').toMatch(/^[a-z][a-z0-9-]*$/);
      expect(issue.dimensions.length, `${issue.code} names the dimension that found it`).toBeGreaterThan(0);
      expect(issue.message.length, `${issue.code} explains itself`).toBeGreaterThan(20);
      expect(issue.guidance, `${issue.code} says what to do`).toBeTruthy();
      if (issue.rect) {
        expect([issue.rect.x, issue.rect.y, issue.rect.w, issue.rect.h].every(Number.isInteger)).toBe(true);
      }
    }
  }, BUILD_TIMEOUT);

  it('renders the same named defects on the page, beside the image', () => {
    const html = card(sprite);
    for (const issue of piece(sprite).issues) {
      expect(html, `${issue.code} should be on the card`).toContain(`<code class="code">${issue.code}</code>`);
      expect(html).toContain(issue.message);
    }
    expect(html).toContain('artwork/verify/lantern-keeper.pixel');
    expect(html).toContain(`src="${piece(sprite).image}"`);
  }, BUILD_TIMEOUT);

  it('separates a decision from a machine repair, rather than guessing', () => {
    // `fix` declines most codes on purpose - a fix that guesses is worse than one that says what
    // a person has to decide - so the page must carry the disposition rather than imply every
    // defect has a button.
    const dispositions = new Set(
      gallery.pieces.flatMap((p) => p.issues.map((i) => i.disposition)),
    );
    for (const disposition of dispositions) {
      expect(['safe-repair-available', 'needs-a-decision']).toContain(disposition);
    }
  }, BUILD_TIMEOUT);
});