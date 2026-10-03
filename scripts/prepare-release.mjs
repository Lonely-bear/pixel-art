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
 *      `## [Unreleased]` cannot silently become what users download, and that the
 *      Chinese mirror has the same heading, because the Release page publishes
 *      both and is generated from them.
 *
 *   node scripts/prepare-release.mjs v0.4.0
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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

// **An annotated tag, or refuse.** `git push --follow-tags` pushes only annotated tags, so a
// lightweight `git tag vX.Y.Z` never leaves the machine — while this script reports "ready to
// build", the branch push succeeds, and `.github/workflows/release.yml` never fires because it
// triggers on the tag. Every symptom is a success and the release still does not happen. That is
// the shape of failure this repository already has five of, in the release tooling rather than in
// the product, so it is checked here rather than discovered on a release day.
const tagType = execFileSync('git', ['cat-file', '-t', tag], { cwd: root, encoding: 'utf8' }).trim();
if (tagType !== 'tag') {
  console.error(`Tag ${tag} is a LIGHTWEIGHT tag (git reports "${tagType}", not "tag").`);
  console.error('`git push --follow-tags` only sends annotated tags, so it would stay on this');
  console.error('machine forever and no installer would ever be built. Recreate it:');
  console.error(`  git tag -d ${tag} && git tag -a ${tag} -m "dotloom-mcp ${pkg.version}"`);
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

// The same section has to exist in the Chinese mirror, because
// `scripts/release-notes.mjs` publishes both on the Release page and refuses to
// build notes without it. Checking it here rather than only there is the point of
// this script: the alternative is discovering a missing translation in the last
// job of the release workflow, three platform builds later. A translation is a
// small thing to ask for before tagging; a rebuilt release is not.
const mirror = path.join(root, 'CHANGELOG-ZH.md');
if (existsSync(mirror)) {
  const chinese = await readFile(mirror, 'utf8');
  if (!released.test(chinese)) {
    console.error(`CHANGELOG-ZH.md has no dated \`## [${pkg.version}] - YYYY-MM-DD\` section.`);
    console.error('The Release page publishes both languages, so translate the section before tagging.');
    process.exit(1);
  }
}

console.log(`Release ${tag} is ready to build.`);
