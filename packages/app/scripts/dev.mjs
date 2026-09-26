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
      // Vite reports localhost and may bind IPv6 on Windows. Probe the same
      // hostname instead of assuming the IPv4 loopback address.
      const socket = createConnection({ port: targetPort, host: 'localhost' });
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

function isPortOpen(targetPort, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection({ port: targetPort, host: 'localhost' });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
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

// 1. Compile the main process and preload script. Wait for it to finish: Electron
// reads dist/electron/main.js the moment it starts, and a half-written bundle
// fails several lines later in a much less obvious place.
await new Promise((resolve, reject) => {
  const bundle = run(node, [path.join(here, 'build-main.mjs')]);
  bundle.once('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`build-main.mjs exited with ${code}`)),
  );
});

// 2. Start Vite — but first make sure the port is actually free. A stale dev
// server from a previous run (Windows does not always deliver SIGINT when the
// terminal is closed, so vite/electron can linger) would otherwise make Vite
// exit and leave Electron pointing at the old server.
if (await isPortOpen(port)) {
  console.error(`\nPort ${port} is already in use.`);
  console.error('Another dev server, or a leftover electron/vite process, is still running.');
  console.error('Close that terminal, or kill the stray processes, then try again.\n');
  process.exit(1);
}
const vite = run(node, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')]);
children.push(vite);
await waitForPort(port);

// 3. Start Electron against the dev server. Print the banner *before* spawning
// so it is not mistaken for "the app started" when Electron then dies.
const electronEntry = (await import('electron')).default;
console.log(`\ndotloom-mcp dev — renderer on ${devServer}\n`);

// Some machines make Electron's GPU process die with a native crash such as
// 0xC0000006 (STATUS_IN_PAGE_ERROR). This shows up with virtual/remote display
// adapters (ToDesk, GameViewer, …) and with Windows memory integrity (HVCI)
// enabled. If it happens, relaunch once with hardware acceleration disabled,
// which is plenty for a pixel editor.
let gpuDisabled = process.env.PIXEL_DISABLE_GPU === '1';
let relaunched = false;

function launchElectron() {
  const electron = run(electronEntry, ['.'], {
    env: {
      ...process.env,
      PIXEL_DEV_SERVER: devServer,
      ...(gpuDisabled ? { PIXEL_DISABLE_GPU: '1' } : {}),
    },
  });
  children.push(electron);
  electron.once('exit', (code) => {
    // Windows native crash codes are >= 0xC0000000 (e.g. 0xC0000006
    // STATUS_IN_PAGE_ERROR, 0xC0000005 ACCESS_VIOLATION). These are not build
    // errors, so point at the things that actually fix them.
    const crashed = typeof code === 'number' && code >= 0xc0000000;
    if (crashed && !gpuDisabled && !relaunched) {
      relaunched = true;
      gpuDisabled = true;
      console.error(
        `\nElectron crashed (exit 0x${(code >>> 0).toString(16)}). Retrying once with hardware acceleration disabled…`,
      );
      launchElectron();
      return;
    }
    if (crashed) {
      console.error(
        `\nElectron crashed (exit 0x${(code >>> 0).toString(16)})${gpuDisabled ? ' even with hardware acceleration off' : ''}. This is a native crash, not a build error.`,
      );
      console.error('Things to try, in order:');
      console.error('  1. Rebuild the Electron binary:  pnpm rebuild electron');
      console.error(
        `  2. Clear the cache: delete "${path.join(process.env.APPDATA ?? '', '@pixel', 'app', 'GPUCache')}" and the other *Cache folders, then retry.`,
      );
      console.error('  3. Check antivirus and Windows memory integrity (HVCI), or exclude the project folder.');
    }
    shutdown(code ?? 0);
  });
}

launchElectron();
