import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = path.join(root, 'dist');

await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: {
    index: path.join(root, 'scripts/npm-index.ts'),
    pixel: path.join(root, 'packages/cli/src/index.ts'),
    'pixel-mcp': path.join(root, 'packages/mcp/src/cli.ts'),
  },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  sourcemap: true,
  treeShaking: true,
  legalComments: 'eof',
  external: [
    '@modelcontextprotocol/sdk',
    'fast-png',
    'fflate',
    'gifenc',
    'zod',
  ],
  logLevel: 'info',
});

await emitDeclarations();

/**
 * Emit `.d.ts` files for the published entry, next to the bundle that serves it.
 *
 * ## Why this is a `tsc` run and not an esbuild flag
 *
 * esbuild has no declaration emit, and the reason is structural rather than a missing feature:
 * the bundle is a single erased JS file with no type information left in it, so the types have
 * to come from the *sources*, which is a TypeScript compiler's job. Running the repository's
 * own `typescript` — the same one `pnpm typecheck` runs — is what keeps the shipped declarations
 * and the checked ones the same answer.
 *
 * ## Why the tree, and not one flat file
 *
 * `scripts/npm-index.ts` imports `@pixel/core` by *relative path* (`../packages/core/src/index.js`),
 * so the emitted entry's own declarations are full of `../packages/core/src/...` specifiers.
 * Emitting the whole reachable tree with `rootDir` at the repository root keeps those relative
 * paths valid *inside the tarball*, which is the only way they can resolve for a consumer.
 * Flattening them into one file would need a third-party `.d.ts` bundler and would produce a
 * different answer from the one the repository typechecks — the drift this repository keeps
 * paying for, in a new place.
 *
 * ## Why the `@pixel/core` specifiers are rewritten, and what that proves
 *
 * A handful of emitted files under `packages/{mcp,script}` say `from '@pixel/core'`. That name
 * resolves inside this repository, through the workspace, and **nowhere else**: it is not a
 * dependency of the published package, so a consumer's `tsc` would report `Cannot find module
 * '@pixel/core'` on a file the consumer never asked for — a `.d.ts` that does not resolve is
 * worse than no `.d.ts`, because it fails at the consumer's build instead of at import. So
 * every bare `@pixel/*` specifier is rewritten to the relative path of the tree that ships it.
 *
 * The remaining external specifiers (`zod`, `fast-png`, `@modelcontextprotocol/sdk`) are real
 * `dependencies` of the package, so a consumer who installed it already has them and they
 * resolve through normal node resolution. `packages/core/test/npm-consumer-types.test.ts`
 * installs the built tarball into a temporary project and compiles against it, which is the
 * only assertion that actually proves any of this.
 */
async function emitDeclarations() {
  const require = createRequire(path.join(root, 'package.json'));
  const manifest = require.resolve('typescript/package.json');
  const tscBin = resolve(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.tsc);
  const typesDir = path.join(outdir, 'types');
  // Written inside `dist/`, which is gitignored build output and is wiped by the `rm` above,
  // so the project file cannot outlive the build that needed it.
  const configPath = path.join(outdir, '.dtsconfig.json');

  mkdirSync(typesDir, { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        extends: path.join(root, 'tsconfig.base.json'),
        compilerOptions: {
          declaration: true,
          emitDeclarationOnly: true,
          // Sourcemaps for declarations are `declarationMap`, and both are off: a consumer's
          // "go to definition" landing in a tarball's flattened copy of a source file is
          // noise, not help.
          declarationMap: false,
          sourceMap: false,
          noEmit: false,
          skipLibCheck: true,
          // The repository root, not `scripts/`: the entry reaches into `packages/*/src`, and
          // a `rootDir` narrower than the emitted set is TS6059.
          rootDir: root,
          outDir: typesDir,
          types: ['node'],
        },
        // `files`, not `include`: `outDir` is inside the config's directory, so an `include`
        // pattern resolves against it and finds nothing.
        files: [path.join(root, 'scripts/npm-index.ts'), path.join(root, 'packages/core/src/gifenc.d.ts')],
      },
      null,
      2,
    )}\n`,
  );

  const run = spawnSync(process.execPath, [tscBin, '-p', configPath], {
    cwd: root,
    encoding: 'utf8',
    // `--listFiles` on a program this size is a few hundred paths; anything near the ceiling
    // should be a loud failure rather than a truncated list that makes a missing file look absent.
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status !== 0) {
    throw new Error(`Declaration emit failed (tsc exited ${run.status}):\n${output}`);
  }
  if (!existsSync(path.join(typesDir, 'scripts', 'npm-index.d.ts'))) {
    throw new Error(`Declaration emit produced no scripts/npm-index.d.ts under ${typesDir}.`);
  }

  rewriteWorkspaceSpecifiers(typesDir);

  // The `types` entry itself, so `exports` can point at one path and a consumer reading the
  // manifest sees what the package is rather than a path into a directory layout.
  writeFileSync(path.join(typesDir, 'index.d.ts'), `export * from './scripts/npm-index.js';\n`);
  rmSync(configPath, { force: true });
  console.log(`Emitted declarations in ${relative(root, typesDir)}/`);
}

/**
 * Rewrite every bare `@pixel/*` specifier in the emitted tree to a relative path inside it.
 *
 * Per-file rather than global, because the right relative path depends on which file the
 * specifier is in — `packages/mcp/src/session.d.ts` and `packages/script/src/sandbox.d.ts` are
 * at different depths from `packages/core/src`. A blanket search-and-replace would produce a
 * `.d.ts` that resolves in exactly one place, which is the failure mode this step removes.
 *
 * **It throws rather than warns.** A surviving `@pixel/*` specifier is the bug this function
 * exists to prevent, and a `console.log` about it is easy to scroll past: the build would go
 * green, publish, and fail on a consumer's machine with a diagnostic about a file they never
 * wrote. The same goes for any *other* bare specifier that is not a declared dependency — those
 * are the ones that resolve through the consumer's own `node_modules` and are therefore fine,
 * and this check is what tells the two cases apart.
 */
function rewriteWorkspaceSpecifiers(typesDir) {
  const coreEntry = path.join(typesDir, 'packages', 'core', 'src', 'index.d.ts');
  if (!existsSync(coreEntry)) {
    throw new Error(`Declaration emit produced no packages/core/src/index.d.ts under ${typesDir}.`);
  }
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  /** Every bare package name the tree still imports, and one file it came from. */
  const external = new Map();
  let rewritten = 0;

  for (const file of declarationFiles(typesDir)) {
    const source = readFileSync(file, 'utf8');
    // Comments come off first, and that is not cosmetic. A `.d.ts` carries the source's whole
    // doc comment, and those are *full of quoted module names*: this repository's own prose
    // says `from 'dotloom-mcp'` and `from '@pixel/core'` in passing. Scanning the raw text
    // classifies a sentence as a specifier, and a check that fires on prose cannot be trusted
    // to report a real one — which is the same rule `npm-surface.test.ts` applies to its own
    // filesystem guard.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\r\n]*/g, '$1 ');
    // Only specifiers in an import/export *position*, and each classified rather than filtered:
    // a relative one is the tree's own business, a `@pixel/*` one must be rewritten, and
    // anything else must be a package this one declares. Matching two of those three would
    // leave the third unchecked, which is the case this check exists for.
    const specifiers = /(from\s+|import\s*\(\s*|^\s*import\s+)(['"])([^'"\n]+)\2/gm;
    for (const match of code.matchAll(specifiers)) {
      const spec = match[3];
      if (spec.startsWith('.') || spec.startsWith('@pixel/')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!external.has(name)) external.set(name, relative(root, file));
    }

    const next = source.replace(specifiers, (match, lead, quote, spec) => {
      if (spec.startsWith('.')) return match;
      if (!spec.startsWith('@pixel/')) return match;
      if (spec !== '@pixel/core') {
        throw new Error(
          `${relative(root, file)} imports "${spec}", which is a workspace package with no published ` +
            'equivalent. Add a rewrite for it here, or stop exporting it.',
        );
      }
      let rel = relative(dirname(file), coreEntry).split(path.sep).join('/');
      if (!rel.startsWith('.')) rel = `./${rel}`;
      // `.js`, not `.d.ts`: `tsc` and every bundler resolve a `.js` specifier to the `.d.ts`
      // beside it, and a `.d.ts` specifier is not portable across resolution modes.
      rel = rel.replace(/\.d\.ts$/, '.js');
      rewritten += 1;
      return `${lead}${quote}${rel}${quote}`;
    });
    if (next !== source) writeFileSync(file, next);
  }

  const undeclared = [...external].filter(([name]) => !declared.has(name));
  if (undeclared.length > 0) {
    throw new Error(
      'The emitted declarations import packages this one does not depend on: ' +
        undeclared.map(([name, from]) => `${name} (from ${from})`).join('; ') +
        '. A consumer cannot resolve those, so the .d.ts would fail at their build rather than at import.',
    );
  }

  console.log(
    `Rewrote ${rewritten} @pixel/core declaration specifier(s) to relative paths; ` +
      `${external.size} external package(s) remain, all declared dependencies: ` +
      `${[...external.keys()].sort().join(', ') || '(none)'}`,
  );
}

/** Every emitted `.d.ts`, recursively. */
function declarationFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...declarationFiles(full));
    else if (entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

console.log(`Built npm distribution in ${relative(root, outdir)}/`);