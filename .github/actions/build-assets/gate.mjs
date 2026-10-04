#!/usr/bin/env node
/**
 * The Action's quality gate: measure every `.pixel` document under a directory
 * and fail the build when one carries a defect the delivery gate refuses.
 *
 * ## What this reports, and what it deliberately does not
 *
 * It prints **named defects** - a code, the dimension that owns it, where it is
 * and the analyzer's own sentence - and nothing else. There is no aggregate
 * score in the output, and that is a product decision rather than an omission:
 * `AGENTS.md` records that a `quality_report` tool shipped once and was deleted
 * in 0.3.1, because a model told the number was "clean" sanded a lake into a
 * dark flat rectangle. A CI log that prints "quality 0.87" invites exactly that.
 * A log that prints `value/flat-value at (2,2) 12x12: one lightness bucket holds
 * 1000/1000 of the solid pixels` is a bug report, and a human judges it.
 *
 * The decision comes from `core.qualityGateForSprite`, the same function
 * `finalize_document` calls before it writes anything, so CI and the delivery
 * path cannot disagree about what "failing" means. At the default `fail`
 * threshold that is an issue at or above §5.3's 500/1000 blocking cut, or a
 * *measured* dimension below its floor. An excluded dimension never refuses: a
 * document where nothing applied declines and says so, rather than being failed
 * for an absence.
 *
 * **An advisory never fails the build.** Below the blocking cut is a `warn`
 * verdict, not a `fail` one, and `decision.passed` is false only for the second.
 * Advisories are still printed, because a named thing a human can look at is
 * worth more than a silence.
 *
 * ## Why `dotloom-mcp` is resolved from the working directory
 *
 * A `uses: owner/repo@v1` action is checked out under `_actions/`, where
 * `node_modules` resolution finds the *action's* neighbours rather than the
 * consumer's, so a bare `import 'dotloom-mcp'` fails for exactly the users this
 * Action exists for. `createRequire` anchored at the working directory's
 * `package.json` resolves the copy the project declared - the one its lockfile
 * pins - and the entry comes from that copy's own `exports` map, so the gate
 * loads exactly the module the project's build script loads. (`require.resolve`
 * on the bare specifier would not do: the package declares an `import`
 * condition and no `require` one, which is correct for an ESM-only consumer API
 * and is why the manifest is resolved and then mapped by hand.)
 *
 * ## Determinism
 *
 * No clock, no randomness, no network. The walk is sorted, so two runs over the
 * same tree report the same defects in the same order, and a CI diff means the
 * artwork changed rather than the run.
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative as relativePath, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const threshold = process.env.DOTLOOM_GATE_THRESHOLD || 'fail';
const dir = process.env.DOTLOOM_GATE_DIR || 'assets/generated';

if (threshold !== 'fail' && threshold !== 'warn') {
  console.error(`DOTLOOM_GATE_THRESHOLD must be "fail" or "warn", got ${JSON.stringify(threshold)}`);
  process.exit(2);
}

async function loadEngine() {
  try {
    const require = createRequire(join(root, 'package.json'));
    const manifestPath = require.resolve('dotloom-mcp/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = manifest.exports['.'];
    const relative = typeof entry === 'string' ? entry : entry.import;
    if (typeof relative !== 'string') {
      throw new Error(`the \`.\` export of ${manifestPath} declares no \`import\` condition`);
    }
    const { core } = await import(pathToFileURL(resolve(dirname(manifestPath), relative)).href);
    return core;
  } catch (error) {
    console.error(
      `Could not load \`dotloom-mcp\` from ${root}. Install it as a devDependency ` +
        '(`npm install --save-dev dotloom-mcp`) or set `install-command` so this Action installs it.',
    );
    console.error(String(error && error.message ? error.message : error));
    process.exit(2);
  }
}

/**
 * Every `.pixel` document under `dir`, sorted, so two runs report in one order.
 * A document outside the directory is impossible here: the walk only ever joins
 * names it read out of that directory.
 */
function findDocuments(base) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return found;
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries.sort(byName)) {
    const path = join(base, entry.name);
    if (entry.isDirectory()) found.push(...findDocuments(path));
    else if (entry.isFile() && entry.name.endsWith('.pixel')) found.push(path);
  }
  return found;
}

/**
 * How a document is named in the log: relative to the working directory when it
 * is inside it, and the absolute path when `asset-dir` points outside it, which
 * is a legal thing to ask for and reads better than a long `../..` chain.
 */
function relativeToRoot(path) {
  const relative = relativePath(root, path);
  return relative.startsWith('..') ? path : relative || path;
}

function where(rect) {
  return rect ? ` at (${rect.x},${rect.y}) ${rect.w}x${rect.h}` : '';
}

const core = await loadEngine();
const documents = findDocuments(resolve(root, dir));

if (documents.length === 0) {
  console.log(
    `quality gate: no .pixel documents under ${dir} - nothing to measure. ` +
      'Set `asset-dir` if the build writes them elsewhere, or `quality-gate: off`.',
  );
  process.exit(0);
}

let refused = 0;
for (const path of documents) {
  const relative = relativeToRoot(path);
  const name = relative.split(sep).join('/') || path;
  const sprite = core.deserializeSprite(readFileSync(path));
  const { decision } = core.qualityGateForSprite(sprite, { threshold });

  // `evaluate` rather than `report.blocking`, because the advisories are the
  // half of the list a human most wants to read and `QualityReport` has no field
  // for a non-blocking issue (§5.4). One measurement, two reads of it.
  const measured = core.createEditor(sprite).execute('evaluate', {});
  const advisories = measured.issues.filter((issue) => !issue.blocking);

  if (decision.passed) {
    console.log(
      `ok   ${name} - no blocking defect` +
        (advisories.length > 0
          ? `, ${advisories.length} advisory finding(s) below the blocking cut`
          : ''),
    );
    for (const issue of advisories) {
      console.log(`       advisory ${issue.dimension}/${issue.code}${where(issue.rect)}: ${issue.message}`);
    }
    continue;
  }

  refused++;
  console.log(`FAIL ${name} - the delivery gate refuses this document:`);
  for (const refusal of decision.refusals) {
    // A `total` refusal is named but its number is withheld. It is the one
    // refusal that comes from a weighted score rather than from a named defect,
    // and a CI log is exactly the place where a printed total becomes a target
    // somebody raises by flattening the art. The decision still counts it - the
    // exit code is unchanged - but the line says what to read instead.
    if (refusal.kind === 'total') {
      console.log(
        '       aggregator/weighted-total: the gate also refuses this document on its weighted ' +
          'total. That number is deliberately not printed here; read the named defects above, ' +
          'which are the actionable half.',
      );
      continue;
    }
    console.log(
      `       ${refusal.dimension}/${refusal.code}${where(refusal.rect)}: ${refusal.message}`,
    );
  }
  for (const issue of advisories) {
    console.log(`       advisory ${issue.dimension}/${issue.code}${where(issue.rect)}: ${issue.message}`);
  }
  console.log(
    '       Fix the named defects and re-run. This log reports defects and prints no score; ' +
      'whether the artwork is good is a person\'s call.',
  );
  if (!decision.measured) {
    console.log('       Note: no dimension applied to this document, so nothing could be measured.');
  }
}

console.log(
  `quality gate: ${documents.length} document(s) measured, ${refused} refused (threshold \`${threshold}\`).`,
);
process.exit(refused > 0 ? 1 : 0);
