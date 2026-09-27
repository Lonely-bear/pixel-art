/**
 * Build a GitHub Release's notes from the changelog.
 *
 * The release page used to be one static file — an install table and a macOS note —
 * so every release carried the same body and the only thing that changed between
 * 0.4.1 and 0.4.2 was a "Full Changelog" link. The prose that says what a release
 * *is* lived in `CHANGELOG.md` and never reached the page at all, which is the one
 * place a person who installed a build will look for it.
 *
 * So the changelog is the source and this script is the join: the shared install
 * section from `.github/release-notes.md`, then the `## [X.Y.Z]` section from
 * `CHANGELOG.md`, then its `CHANGELOG-ZH.md` twin collapsed behind a `<details>`,
 * then the compare link. Nothing about the result has to be maintained twice, and
 * the release page cannot describe a release the changelog does not.
 *
 *   node scripts/release-notes.mjs v0.4.2 > release-notes.md
 *
 * The previous version is read from the *next* dated section in the changelog
 * rather than from `git`, because the workflow checks out a single commit and the
 * changelog already carries the invariant this relies on: `prepare-release.mjs`
 * refuses a tag whose version has no dated section, so every tag is in the file and
 * the file is ordered newest first.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => readFile(path.join(root, relative), 'utf8');

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/release-notes.mjs vX.Y.Z');
  process.exit(1);
}
const version = arg.replace(/^v/, '');

/**
 * Every dated section of a changelog, in file order, with its body.
 *
 * The heading is the only structure either changelog has, which is what
 * `prepare-release.mjs` already matches on — one shape, matched twice, rather than
 * two parsers that can disagree about what a version section is.
 */
function sections(text) {
  const heading = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm;
  const found = [];
  for (const match of text.matchAll(heading)) {
    const start = match.index + match[0].length;
    const rest = text.slice(start);
    // The body runs to the next line that starts with `## `, whatever level the
    // section used, so an `## [Unreleased]` placeholder or the next version both
    // end it and neither can leak into the notes.
    const end = rest.search(/^## /m);
    found.push({
      version: match[1],
      date: match[2],
      body: rest.slice(0, end === -1 ? undefined : end).trim(),
    });
  }
  return found;
}

const [english, chinese, install, pkg] = await Promise.all([
  read('CHANGELOG.md'),
  read('CHANGELOG-ZH.md'),
  read('.github/release-notes.md'),
  read('package.json'),
]);

const changelog = sections(english);
const index = changelog.findIndex((section) => section.version === version);
const entry = changelog[index];
if (!entry) {
  console.error(`CHANGELOG.md has no \`## [${version}] - YYYY-MM-DD\` section to publish.`);
  console.error('The release page is generated from the changelog, so this is not optional.');
  process.exit(1);
}

// Newest first, so the entry below this one is the release it supersedes. Absent
// for a first release, and the link falls back to the tag's own page.
const previous = changelog[index + 1];

// Same heading shape in both files, so a missing Chinese mirror is a hard error
// rather than a release page that quietly ships in one language.
const mirror = sections(chinese).find((section) => section.version === version);
if (!mirror) {
  console.error(`CHANGELOG-ZH.md has no \`## [${version}] - YYYY-MM-DD\` section.`);
  console.error('The Chinese mirror is part of the release, not a follow-up.');
  process.exit(1);
}

const slug = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i.exec(
  JSON.parse(pkg).repository.url,
)?.[1];
if (!slug) {
  console.error('Could not read the GitHub slug out of package.json `repository.url`.');
  process.exit(1);
}

const out = [
  install.trim(),
  '---',
  `## What's changed in ${version}`,
  entry.body,
  '<details>',
  `<summary>中文变更说明 · ${version}（${entry.date}）</summary>`,
  '',
  mirror.body,
  '',
  '</details>',
  '',
  previous
    ? `**Full Changelog**: https://github.com/${slug}/compare/v${previous.version}...v${version}`
    : `**Full Changelog**: https://github.com/${slug}/releases/tag/v${version}`,
].join('\n\n');

process.stdout.write(`${out}\n`);
