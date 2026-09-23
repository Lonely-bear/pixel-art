/**
 * Dev launcher: compile the Electron side once, start Vite, wait for it to
 * actually accept connections, then start Electron pointed at the dev server.
 *
 * No extra dependencies — Vite and Electron are both resolved out of
 * node_modules and run with the current Node binary.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const node = process.execPath;
const port = 5273;
const devServer = `http://localhost:${port}`;

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
}

function waitForPort(targetPort, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port: targetPort, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`Vite did not start on port ${targetPort}`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

const children = [];
function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// 1. Compile the main process and preload script.
await new Promise((resolve, reject) => {
  const tsc = run(node, [path.join(root, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);
  tsc.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tsc exited with ${code}`))));
});

// 2. Start Vite.
const vite = run(node, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')]);
children.push(vite);
await waitForPort(port);

// 3. Start Electron against the dev server.
const electronEntry = (await import('electron')).default;
const electron = run(electronEntry, ['.'], {
  env: { ...process.env, PIXEL_DEV_SERVER: devServer },
});
children.push(electron);
electron.once('exit', (code) => shutdown(code ?? 0));

console.log(`\nPixel Art dev — renderer on ${devServer}\n`);
