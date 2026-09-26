/**
 * Bundle the Electron main process and preload script.
 *
 * The app runs `@pixel/core` and `@pixel/mcp` straight out of the workspace, and
 * pnpm wires those up as symlinks. electron-builder copies real files, so a
 * symlinked dependency either vanishes from the package or arrives as a broken
 * link. Bundling sidesteps the whole question: the workspace packages and their
 * npm dependencies are inlined into two standalone files, and the packaged app
 * needs no `node_modules` at all.
 *
 * This mirrors `scripts/build-npm-package.mjs`, which does the same thing for the
 * published CLI. `pnpm typecheck` still runs `tsc --noEmit` over these sources,
 * so nothing is lost by emitting with esbuild instead.
 *
 *   node scripts/build-main.mjs
 */
import { rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const outdir = path.join(dist, 'electron');

// `build` runs this before Vite, so wiping `dist/` here is safe. It matters
// because the previous compiler emitted `tsc`-style per-module output
// (dist/electron/host.js, dist/shared/types.js, …) into the same tree. Those
// leftovers are now inlined into main.js, so leaving them around would ship
// dead copies of the code inside the installer.
await rm(dist, { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22.13',
  // The main process is ESM (`"type": "module"` in package.json) and Electron
  // loads it as such, so `import.meta.url` in main.ts keeps resolving the
  // preload and renderer paths next to the bundle.
  format: 'esm',
  sourcemap: true,
  treeShaking: true,
  legalComments: 'eof',
  // Supplied by the runtime, never bundled. `electron` is a devDependency here
  // and resolving it to the real binary's entry point would inline Electron
  // itself into the app.
  external: ['electron'],
  // Whether this build will be signed, which the updater cannot find out at
  // runtime: macOS will not hand the signature to a running app, and the answer
  // decides whether the app may replace itself. Read from the same variable
  // electron-builder takes its certificate from, in the same job, so the value
  // describes the artefact this bundle is about to be packed into rather than a
  // guess made later.
  define: {
    __PIXEL_CODESIGNED__: JSON.stringify(
      Boolean(process.env.CSC_LINK || process.env.APPLE_CERTIFICATE),
    ),
  },
  logLevel: 'info',
};

// Only the ESM build needs it, and it must not reach the CommonJS preload:
// `import.meta` does not exist there. The reason it is needed at all is that
// bundling a CommonJS dependency into an ESM file leaves its `require('fs')`
// pointing at a shim which throws "Dynamic require of fs is not supported"
// unless something called `require` is in scope. `graceful-fs`, reached through
// `fs-extra` and `electron-updater`, does exactly that, and the app refuses to
// start without it. One real `require` in the output file is the shim looking
// for, so it is provided — narrowly, by a header rather than by shipping
// `node_modules` alongside the bundle.
const cjsInteropBanner = [
  "import { createRequire as __createRequire } from 'node:module';",
  'const require = __createRequire(import.meta.url);',
].join('\n');

await build({
  ...shared,
  entryPoints: [path.join(root, 'electron', 'main.ts')],
  outfile: path.join(outdir, 'main.js'),
  banner: { js: cjsInteropBanner },
});

await build({
  ...shared,
  entryPoints: [path.join(root, 'electron', 'preload.cts')],
  outfile: path.join(outdir, 'preload.cjs'),
  // The window is created with `sandbox: true`, which only ever runs a CommonJS
  // preload, and the `.cjs` extension is what tells Electron to load it that way.
  format: 'cjs',
});
