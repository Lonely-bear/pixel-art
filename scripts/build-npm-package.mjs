import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const outdir = path.join(root, 'dist');

await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: {
    pixel: path.join(root, 'packages/cli/src/index.ts'),
    'pixel-mcp': path.join(root, 'packages/mcp/src/cli.ts'),
  },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.12',
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

console.log(`Built npm binaries in ${path.relative(root, outdir)}/`);
