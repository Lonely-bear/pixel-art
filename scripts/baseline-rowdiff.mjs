/**
 * PO verification tool. A row-level diff of two baseline files, keyed on the first cell, so a change
 * reads as "this row, these columns, this direction" rather than as a wall of added/removed lines.
 * Compare-Object counts lines; it cannot say which subject moved or whether a score went up.
 *
 *   node scripts/baseline-rowdiff.mjs <old.md> <new.md>
 */
import { readFileSync } from 'node:fs';

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error('usage: node scripts/baseline-rowdiff.mjs <old.md> <new.md>');
  process.exit(1);
}

/** Index every table row by its first cell, tagged with the section it sits in. */
function index(lines) {
  const rows = new Map();
  let section = '(head)';
  for (const line of lines) {
    if (line.startsWith('#')) section = line.replace(/^#+\s*/, '').slice(0, 44);
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const key = cells[1];
    if (!key || key === 'case' || /^-+/.test(key)) continue;
    rows.set(`${section} :: ${key}`, cells);
  }
  return rows;
}

const before = index(readFileSync(oldPath, 'utf8').split('\n'));
const after = index(readFileSync(newPath, 'utf8').split('\n'));

const added = [...after.keys()].filter((k) => !before.has(k));
const removed = [...before.keys()].filter((k) => !after.has(k));
const changed = [];

for (const key of after.keys()) {
  if (!before.has(key)) continue;
  const a = before.get(key);
  const b = after.get(key);
  if (a.join(' ') === b.join(' ')) continue;
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diffs.push(`c${i}: ${a[i] ?? '-'}  ->  ${b[i] ?? '-'}`);
  }
  changed.push({ key, diffs });
}

console.log(`rows added:   ${added.length}`);
for (const k of added) console.log(`  + ${k}`);
console.log(`rows removed: ${removed.length}`);
for (const k of removed) console.log(`  - ${k}`);
console.log(`rows changed: ${changed.length}`);
for (const { key, diffs } of changed) {
  console.log(`\n~ ${key}`);
  for (const d of diffs) console.log(`    ${d}`);
}