/**
 * Prepare a tagged release, and refuse to build one that is not ready.
 *
 * The release workflow pushes a `vX.Y.Z` tag and this runs before anything is
 * compiled. It does three things:
 *
 *   1. checks the tag matches the root package version, so a mistyped tag
 *      cannot ship a Release labelled one version and installers built from
 *      another;
 *   2. copies that version into `packages/app/package.json`, which is where
 *      electron-builder reads the installer version from — the app is a separate
 *      workspace package and would otherwise drift behind the published one;
 *   3. checks the changelog has a dated heading for the version, so
 *      `## [Unreleased]` cannot silently become what users download.
 *
 *   node scripts/prepare-release.mjs v0.4.0
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = async (relative) =>
  JSON.parse(await readFile(path.join(root, relative), 'utf8'));

const tag = process.argv[2];
if (!tag) {
  console.error('usage: node scripts/prepare-release.mjs vX.Y.Z');
  process.exit(1);
}

const pkg = await readJson('package.json');
const expected = `v${pkg.version}`;

if (tag !== expected) {
  console.error(`Tag ${tag} does not match package.json version ${pkg.version} (expected ${expected}).`);
  console.error('Bump the version first, or retag.');
  process.exit(1);
}

const appPath = 'packages/app/package.json';
const app = await readJson(appPath);
if (app.version !== pkg.version) {
  app.version = pkg.version;
  // Two-space indent and a trailing newline, matching every other manifest in
  // the workspace, so the release commit does not reformat the whole file.
  await writeFile(path.join(root, appPath), `${JSON.stringify(app, null, 2)}\n`);
  console.log(`Set ${appPath} version to ${pkg.version}`);
}

const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
// A dated heading, as opposed to the `## [Unreleased]` placeholder or a bare
// `## [0.4.0]` that was never given its release date.
const released = new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');
if (!released.test(changelog)) {
  console.error(`CHANGELOG.md has no dated \`## [${pkg.version}] - YYYY-MM-DD\` section.`);
  console.error('Promote the Unreleased notes before tagging a release.');
  process.exit(1);
}

console.log(`Release ${tag} is ready to build.`);
