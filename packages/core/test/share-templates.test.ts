import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { decodePNG, encodePNG, readPNGMetadata } from '../src/png.js';

/**
 * The share bundle, `scripts/build-share.mjs` -> `share/`.
 *
 * A share bundle is a build artifact that is *designed to leave the building*, which makes it the
 * most dangerous place in this repository to put a number and the least acceptable place to put a
 * half-truth. Four claims, each measured here rather than asserted in prose:
 *
 *   1. **Two generations are byte-identical.** `--verify` generates the whole tree twice and
 *      byte-compares every file. A clock, a session id or an incidental `readdir` order in a file
 *      people forward to each other shows up as a diff on every commit.
 *
 *   2. **No score anywhere** - not in `share.json`, not in the card HTML, not in the PNG's text
 *      chunks. The walk is over key *names*, recursively, the same one
 *      `packages/core/test/gallery.test.ts` and `packages/cli/test/contract.test.ts` use: `evaluate`
 *      returns `score` and `scoreQ` on every dimension, and copying one field would be enough to
 *      reintroduce the tool that was deleted in 0.3.1.
 *
 *   3. **The artwork survives sharing.** This is the assertion that decides the badge design. The
 *      shared PNG is compared, pixel for pixel, against a second render of the same document with
 *      no metadata attached: if the badge were burned in, these would differ. It also carries a
 *      `Software` chunk, so the badge is *there* and not in the pixels - both halves, because
 *      either alone would pass a weaker test.
 *
 *   4. **An abstention is not a pass.** `verify--lantern-keeper` is a single-frame sprite, so
 *      `motion` abstains with `single-frame`; it must appear under *not measured* with the reason
 *      spelled out, and must **not** appear in the list of dimensions that measured the piece.
 *
 * The build needs `packages/mcp/dist/cli.js`, so `pnpm build:libs` is a prerequisite - the usual
 * trap documented in `AGENTS.md`. The script is spawned rather than imported because it reaches the
 * engine only through the advertised MCP tool surface.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'build-share.mjs');
const shareRoot = join(repoRoot, 'share');
const templateRoot = join(repoRoot, 'share-templates');

/**
 * Four templates over eleven pieces, twice, plus a sheet and a contract each where the template
 * asks for one. Generous, because a cold CI runner is slower than a warm laptop and `AGENTS.md`
 * records three intermittent 5-second timeouts this repository has already shipped.
 */
const BUILD_TIMEOUT = 900_000;

/** The pieces the assertions below name. Both are real, committed, and structurally different. */
const SPRITE = 'verify--lantern-keeper'; // 32x32, one frame, three layers, real defects.
const SCENE = 'autumn-dusk-lake-256'; // full-bleed: `silhouette` and `outline` abstain `no-subject`.

let stdout = '';
let stderr = '';
let status: number | null = null;
let index: ShareIndex;

interface ShareIssue {
  code: string;
  dimensions: string[];
  rect: { x: number; y: number; w: number; h: number } | null;
  blocking: boolean;
  message: string;
  disposition: string;
  guidance: string | null;
}
interface ShareBundle {
  id: string;
  slug: string;
  template: string;
  source: string;
  width: number;
  height: number;
  image: string;
  imageBytes: number;
  imageSha256: string;
  badge: { carriedAs: string; keyword: string; value: string; burnedIn: boolean };
  provenance: Record<string, string>;
  measuredDimensions: string[];
  notMeasured: { dimension: string; reason: string; note: string }[];
  issues: ShareIssue[];
  delivery: { refused: boolean; reason?: string; assets?: { contentHash: string }[] } | null;
  files: { role: string; path: string }[];
}
interface ShareIndex {
  generatedBy: string;
  engine: { name: string; version: string };
  templates: { id: string; outputs: string[]; card: string | null }[];
  bundles: ShareBundle[];
}

/**
 * Recursively collect every key name in a value, so a nested `score` cannot hide. Names, not
 * values, because the number is the thing that must not exist.
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

function bundle(template: string, slug: string): ShareBundle {
  const found = index.bundles.find((b) => b.template === template && b.slug === slug);
  if (!found) {
    throw new Error(`no ${template} bundle for "${slug}"; ids are ${index.bundles.map((b) => `${b.template}/${b.slug}`).join(', ')}`);
  }
  return found;
}

function dir(template: string, slug: string): string {
  return join(shareRoot, template, slug);
}

function card(template: string, slug: string): string {
  return readFileSync(join(dir(template, slug), 'card.html'), 'utf8');
}

beforeAll(() => {
  const run = spawnSync(process.execPath, [script, '--verify'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  stdout = run.stdout ?? '';
  stderr = run.stderr ?? '';
  status = run.status;
  if (!existsSync(join(shareRoot, 'share.json'))) {
    throw new Error(`the share script produced nothing:\n${stdout}\n${stderr}`);
  }
  index = JSON.parse(readFileSync(join(shareRoot, 'share.json'), 'utf8')) as ShareIndex;
}, BUILD_TIMEOUT);

describe('a share bundle is a build artifact, so it reproduces', () => {
  it('is byte-identical across two generations, and says so', () => {
    // Asserting the script's own verdict rather than repeating the expensive part keeps the two
    // generations in one place, so a regression in the bytes cannot pass by failing to mention it.
    expect(stdout).toMatch(/verified: a second generation produced byte-identical output for \d+ file\(s\)/);
    expect(status, `${stdout}\n${stderr}`).toBe(0);
  }, BUILD_TIMEOUT);

  it('ships every committed piece under every template, without a hand-written list', () => {
    // The anti-drift gate, the same mechanism the gallery uses: a `.pixel` committed to `artwork/`
    // must be shareable without anyone editing the generator.
    const sources = new Set(index.bundles.map((b) => b.source));
    expect([...sources].sort()).toEqual([...sources]);
    expect(sources.has('artwork/verify/lantern-keeper.pixel')).toBe(true);
    expect(sources.has('artwork/autumn-dusk-lake-256.pixel')).toBe(true);
    for (const template of index.templates) {
      for (const source of sources) {
        expect(
          index.bundles.some((b) => b.template === template.id && b.source === source),
          `${template.id} has no bundle for ${source}`,
        ).toBe(true);
      }
    }
  }, BUILD_TIMEOUT);

  it('records a hash that matches the file it points at, so the bundle cannot drift', () => {
    for (const b of index.bundles) {
      const onDisk = readFileSync(join(dir(b.template, b.slug), b.image));
      expect(createHash('sha256').update(onDisk).digest('hex'), `${b.template}/${b.slug}`).toBe(b.imageSha256);
      expect(b.imageBytes).toBe(onDisk.length);
    }
  }, BUILD_TIMEOUT);
});

describe('a share bundle publishes no score', () => {
  it('puts no verdict-shaped key in share.json', () => {
    for (const keyPath of keyPaths(index)) {
      expect(FORBIDDEN.test(keyPath), `${keyPath} looks like a verdict`).toBe(false);
    }
  }, BUILD_TIMEOUT);

  it('names no such thing in the card text either', () => {
    // Over the whole document including the part that explains why the numbers are absent: a
    // reader skimming the card must not be able to find a number to move toward, even by accident.
    const templates = index.templates.filter((t) => t.card !== null).map((t) => t.id);
    expect(templates.length, 'no template renders a card, so this would pass vacuously').toBeGreaterThan(0);
    const hits: string[] = [];
    for (const template of templates) {
      for (const b of index.bundles.filter((x) => x.template === template)) {
        card(template, b.slug)
          .split('\n')
          .forEach((line, i) => {
            if (FORBIDDEN.test(line)) hits.push(`${template}/${b.slug}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(hits).toEqual([]);
  }, BUILD_TIMEOUT);

  it('carries no verdict in the PNG text chunks either', () => {
    // The chunk that travels furthest: it survives being pasted, mailed and re-saved by a person
    // who never opens the file. Only *defect codes* go in, and only under the one keyword.
    for (const b of index.bundles) {
      const text = readPNGMetadata(new Uint8Array(readFileSync(join(dir(b.template, b.slug), b.image))));
      for (const [key, value] of Object.entries(text)) {
        expect(FORBIDDEN.test(key), `${b.template}/${b.slug} chunk ${key}`).toBe(false);
        // And no bare number, which is the `dotloom:schema` exemption and nothing else.
        if (key !== 'dotloom:schema') {
          expect(/^[+-]?\d+(\.\d+)?\s*%?$/.test(value.trim()), `${key} holds a bare number`).toBe(false);
        }
      }
    }
  }, BUILD_TIMEOUT);
});

describe('the badge is carried, not burned', () => {
  it('is present as a text chunk on every shared PNG', () => {
    for (const b of index.bundles) {
      const text = readPNGMetadata(new Uint8Array(readFileSync(join(dir(b.template, b.slug), b.image))));
      expect(text.Software, `${b.template}/${b.slug} has no badge`).toBe('dotloom-mcp');
      expect(text['dotloom:defects'], 'the honest channel is populated').toBeTypeOf('string');
      expect(b.badge.burnedIn).toBe(false);
      expect(b.badge.carriedAs).toBe('png-text-chunk');
    }
  }, BUILD_TIMEOUT);

  it('leaves the artwork bit-for-bit identical to an unbadged render of the same document', () => {
    // **This is the assertion the design rests on.** The comparison is against a *second process*:
    // `mcp-call.mjs` opens the same `.pixel` and runs `export_png` into a scratch file with no
    // badge, no metadata and no knowledge that this repository exists. If the badge were
    // composited into the pixels, the two decodes would differ. They do not - so the artwork
    // underneath is recoverable by anyone who decodes the file, which is the property a burned
    // badge destroys.
    //
    // Scale 8 is what `build-share.mjs` itself derives for a 32x32 canvas against the default
    // `targetLongSide` of 256, so the two renders are the same render and not two similar ones.
    const scratch = mkdtempSync(join(tmpdir(), 'badge-probe-'));
    const plainPath = join(scratch, 'plain.png');
    const planFile = join(scratch, 'plan.json');
    writeFileSync(
      planFile,
      JSON.stringify([
        { label: 'open', tool: 'open_document', arguments: { path: 'artwork/verify/lantern-keeper.pixel' } },
        { label: 'render', tool: 'export_png', arguments: { out: plainPath, scale: 8 } },
      ]),
    );
    const run = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'mcp-call.mjs'), 'calls', planFile], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);

    const shared = decodePNG(new Uint8Array(readFileSync(join(dir('bare', SPRITE), `${SPRITE}.png`))));
    const plain = decodePNG(new Uint8Array(readFileSync(plainPath)));

    expect(shared.width).toBe(plain.width);
    expect(shared.height).toBe(plain.height);
    expect([...shared.data], 'the badge must not have touched a pixel').toEqual([...plain.data]);
    // Positive half: the two files really are different files, so this is not passing because
    // nothing happened. The badge is in the bytes; it is not in the pixels.
    expect(readFileSync(join(dir('bare', SPRITE), `${SPRITE}.png`)).length).not.toBe(
      readFileSync(plainPath).length,
    );
  }, BUILD_TIMEOUT);

  it('un-badges by re-encoding, because there is nothing to un-burn', () => {
    // The operation a recipient performs: decode, drop the chunks, re-encode. The result is the
    // engine's render, byte for byte - which is only true because the badge was never a pixel.
    const sharedBytes = new Uint8Array(readFileSync(join(dir('bare', SPRITE), `${SPRITE}.png`)));
    const unbadged = encodePNG(decodePNG(sharedBytes));
    expect(readPNGMetadata(unbadged)).toEqual({});
    expect([...decodePNG(unbadged).data]).toEqual([...decodePNG(sharedBytes).data]);
  }, BUILD_TIMEOUT);

  it('names the same defect codes in the chunk that the card names', () => {
    // One list, two renderings. A badge claiming defects the card does not list - or the reverse -
    // is worse than no badge, because a forwarded file then carries a claim nobody checked.
    const b = bundle('card', SPRITE);
    const text = readPNGMetadata(new Uint8Array(readFileSync(join(dir('card', SPRITE), b.image))));
    const inChunk = text['dotloom:defects'] ? text['dotloom:defects'].split(',') : [];
    expect(inChunk).toEqual(b.issues.map((i) => i.code));
    for (const code of inChunk) {
      expect(card('card', SPRITE), `${code} should be on the card`).toContain(`<code class="code">${code}</code>`);
    }
  }, BUILD_TIMEOUT);
});

describe('an abstention is not a pass', () => {
  it('carries the ExcludedReason on a full-bleed scene, and does not also claim it measured', () => {
    // `autumn-dusk-lake-256` is the case this repository has already got wrong once: `silhouette`
    // was confidently reporting a blocking `shape-clipped` on all ten full-bleed artworks because
    // the alpha boundary of a scene *is* the canvas. It abstains with `no-subject` now, and the
    // bundle has to say so rather than tick a box.
    const b = bundle('card', SCENE);
    const abstained = b.notMeasured.filter((n) => n.reason === 'no-subject');
    expect(abstained.map((n) => n.dimension).sort()).toEqual(['outline', 'silhouette']);
    for (const entry of abstained) {
      expect(entry.note.length, `${entry.dimension} must explain itself`).toBeGreaterThan(40);
      expect(b.measuredDimensions, `${entry.dimension} is in both blocks`).not.toContain(entry.dimension);
    }
  }, BUILD_TIMEOUT);

  it('renders the abstention as "not measured", on the card, for that piece only', () => {
    const html = card('card', SCENE);
    expect(html).toContain('Not measured');
    expect(html).toContain('not the same as clean');
    expect(html).toContain('no-subject');
    const measured = /dimensions that measured this piece<\/span>\s*<ul>(.*?)<\/ul>/s.exec(html);
    expect(measured, 'no measured-dimensions block').not.toBeNull();
    expect(measured?.[1]).not.toContain('silhouette');
  }, BUILD_TIMEOUT);

  it('says single-frame is not motion on the sprite, in every template that renders a card', () => {
    // The near-miss on the other side of the same gate: the sprite *does* get measured by five
    // dimensions, so a bundle that reported nothing at all would look like the abstention case.
    for (const template of index.templates.filter((t) => t.card !== null).map((t) => t.id)) {
      const b = bundle(template, SPRITE);
      expect(b.measuredDimensions.length, `${template} measured nothing`).toBeGreaterThan(0);
      expect(b.notMeasured.map((n) => n.reason), `${template}`).toContain('single-frame');
    }
  }, BUILD_TIMEOUT);
});

describe('a defect is named, located and actionable', () => {
  it('names every issue with a code, a dimension, a region and what to do', () => {
    const b = bundle('card', SPRITE);
    expect(b.issues.length).toBeGreaterThan(0);
    for (const issue of b.issues) {
      expect(issue.code).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(issue.dimensions.length, `${issue.code} names the dimension that found it`).toBeGreaterThan(0);
      expect(issue.message.length, `${issue.code} explains itself`).toBeGreaterThan(20);
      expect(issue.guidance, `${issue.code} says what to do`).toBeTruthy();
      if (issue.rect) {
        expect([issue.rect.x, issue.rect.y, issue.rect.w, issue.rect.h].every(Number.isInteger)).toBe(true);
      }
    }
  }, BUILD_TIMEOUT);

  it('separates a decision from a machine repair, rather than guessing', () => {
    const dispositions = new Set(index.bundles.flatMap((b) => b.issues.map((i) => i.disposition)));
    for (const disposition of dispositions) {
      expect(['safe-repair-available', 'needs-a-decision']).toContain(disposition);
    }
  }, BUILD_TIMEOUT);

  it('puts the same named defects on the card as in the manifest', () => {
    const b = bundle('review', SPRITE);
    const html = card('review', SPRITE);
    for (const issue of b.issues) {
      expect(html, `${issue.code} should be on the card`).toContain(`<code class="code">${issue.code}</code>`);
    }
    expect(html).toContain(b.source);
  }, BUILD_TIMEOUT);
});

describe('the templates are presentation, and are kept apart from recipes', () => {
  it('ships four, each with a summary a reader can act on', () => {
    expect(index.templates.map((t) => t.id).sort()).toEqual(['bare', 'card', 'handoff', 'review']);
    for (const t of index.templates) {
      expect(t.outputs.length, `${t.id} writes nothing`).toBeGreaterThan(0);
    }
  }, BUILD_TIMEOUT);

  it('writes a card only where the template asks for one', () => {
    // `bare` exists precisely to be the template with no rendered judgement layer, and a test that
    // does not check that would let a card creep into every bundle without anything failing.
    expect(existsSync(join(dir('bare', SPRITE), 'card.html')), 'bare should have no card').toBe(false);
    expect(existsSync(join(dir('card', SPRITE), 'card.html')), 'card should have a card').toBe(true);
    expect(bundle('bare', SPRITE).files.some((f) => f.role === 'card')).toBe(false);
  }, BUILD_TIMEOUT);

  it('keeps the presets out of recipes/, where describe_recipe would have to learn about them', () => {
    // A recipe is art direction read by an agent to decide what to draw; a share template is
    // presentation read by a person deciding what to send. One catalogue, two vocabularies, one
    // directory each - asserted here because the merge is easy and the failure is silent.
    for (const name of ['card', 'handoff', 'bare', 'review']) {
      expect(existsSync(join(templateRoot, `${name}.share.json`)), `${name}.share.json`).toBe(true);
    }
    const recipes = readFileSync(join(repoRoot, 'recipes', 'README.md'), 'utf8');
    expect(recipes, 'recipes must not advertise share templates').not.toMatch(/share-template|\.share\.json/);
  }, BUILD_TIMEOUT);

  it('writes portable paths, because the record is as movable as the bundle', () => {
    // `finalize_document` reports absolute, platform-native paths. A `share.json` holding
    // `share\\handoff\\...` cannot travel to a Linux build machine, which is exactly what
    // ASSET-CONTRACT S5.1 exists to prevent.
    for (const b of index.bundles) {
      for (const file of b.files) {
        expect(file.path, `${b.template}/${b.slug} path ${file.path}`).not.toContain('\\');
        expect(file.path).not.toMatch(/^[A-Za-z]:/);
        expect(file.path.split('/')).not.toContain('..');
      }
    }
  }, BUILD_TIMEOUT);
});

describe('the opt-in contract is opt-in', () => {
  it('writes meta.json only for the template that asked for it', () => {
    // The same policy `finalize_document`, the CLI and the app already implement: a target engine
    // is the caller's choice, and a tool cannot know it.
    expect(existsSync(join(dir('handoff', SPRITE), 'meta.json')), 'handoff writes a contract').toBe(true);
    for (const template of ['bare', 'card', 'review']) {
      expect(existsSync(join(dir(template, SPRITE), 'meta.json')), `${template} should not`).toBe(false);
    }
    expect(bundle('bare', SPRITE).delivery, 'bare asks for no contract').toBeNull();
  }, BUILD_TIMEOUT);

  it('names the same content hash in the PNG chunk that meta.json carries', () => {
    // The round trip the whole provenance channel exists for: a recipient can check the image
    // against the contract without re-compositing a single frame.
    const b = bundle('handoff', SPRITE);
    const text = readPNGMetadata(new Uint8Array(readFileSync(join(dir('handoff', SPRITE), b.image))));
    const meta = JSON.parse(readFileSync(join(dir('handoff', SPRITE), 'meta.json'), 'utf8'));
    expect(text['dotloom:contract']).toBe(meta.format);
    expect(text['dotloom:schema']).toBe(String(meta.schemaVersion));
    expect(text['dotloom:asset']).toBe(meta.asset.contentHash);
    expect(b.delivery?.assets?.[0]?.contentHash).toBe(meta.asset.contentHash);
  }, BUILD_TIMEOUT);

  it('never invents a licence', () => {
    // S11: absent is not public domain. No shipped template declares one, so no bundle may claim
    // one - and if a template ever does, it has to appear here rather than appear silently.
    for (const b of index.bundles) {
      expect(Object.keys(b.provenance), `${b.template} claims a licence`).not.toContain('dotloom:license');
    }
  }, BUILD_TIMEOUT);
});
