import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { removeHostFile, writeHostFile } from '@pixel/mcp';
import { CHANNELS } from '../shared/types.js';
import { DEFAULT_MCP_PORT, startMcpHost, type McpHost } from './mcp-host.js';
import { registerIpc } from './ipc.js';
import { store } from './host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const devServer = process.env.PIXEL_DEV_SERVER;

// Escape hatch for machines where the GPU process misbehaves and the window
// never appears. Must be called before the app is ready.
//   PIXEL_DISABLE_GPU=1 pnpm --filter @pixel/app dev
if (process.env.PIXEL_DISABLE_GPU === '1') app.disableHardwareAcceleration();

let window: BrowserWindow | undefined;
let mcp: McpHost | undefined;
let mcpStatus: ReturnType<McpHost['status']> = { running: false };

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0b0c',
    title: 'dotloom-mcp',
    show: false,
    // The renderer draws its own 40px title bar, so the OS frame and the
    // application menu are both gone. Everything the frame used to provide —
    // drag, snap layouts, resize borders, minimise/maximise/close — is either
    // free with `frame: false` or handled by `TitleBar` in the renderer.
    frame: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  created.once('ready-to-show', () => created.show());
  // Safety net: if `ready-to-show` never fires (a flaky first paint can swallow
  // it), still reveal the window once the document has loaded so a blank window
  // is never mistaken for "the app did not open".
  created.webContents.once('did-finish-load', () => {
    if (!created.isVisible()) created.show();
  });
  created.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[dotloom-mcp] renderer failed to load (${code} ${description}): ${url}`);
  });
  created.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[dotloom-mcp] renderer process gone: ${details.reason}`);
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the drawer's window-button glyph in sync with the real state, so a
  // double-click on the drag region cannot leave the icon lying.
  const pushState = () => {
    if (created.isDestroyed()) return;
    created.webContents.send(CHANNELS.windowState, { maximized: created.isMaximized() });
  };
  created.on('maximize', pushState);
  created.on('unmaximize', pushState);
  created.on('enter-full-screen', pushState);
  created.on('leave-full-screen', pushState);

  // With no application menu there is nothing for Electron to route a chord to,
  // so each window claims its own accelerators and forwards the intent.
  created.webContents.on('before-input-event', (_event, input) => forwardAccelerator(input));

  if (devServer) {
    void created.loadURL(devServer);
  } else {
    void created.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  }

  return created;
}

/**
 * Accelerators that used to live on the application menu.
 *
 * With no menu there is nothing for Electron to route a key chord to, so the
 * main process claims them itself and forwards the intent to the renderer. The
 * renderer still owns the behaviour; this only replaces the menu plumbing.
 */
const ACCELERATORS: Record<string, string> = {
  n: 'new',
  o: 'open',
  s: 'save',
  e: 'export',
  z: 'undo',
  ',': 'settings',
  '\\': 'toggle-sidebar',
};

/**
 * Chords where Shift changes the meaning. Consulted instead of `ACCELERATORS`
 * whenever Shift is down, so `Ctrl+Shift+Z` forwards `redo` rather than
 * `undo` — and a chord with no shifted meaning simply does nothing.
 */
const SHIFTED_ACCELERATORS: Record<string, string> = {
  z: 'redo',
};

function forwardAccelerator(input: Electron.Input): void {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return;
  if (input.alt) return;
  if (!input.control && !input.meta) return;
  // An event with no `key` (injected input carries neither `key` nor `code`)
  // resolves to `undefined` here, which correctly does nothing.
  const action = (input.shift ? SHIFTED_ACCELERATORS : ACCELERATORS)[input.key.toLowerCase()];
  if (!action) return;
  const target = BrowserWindow.getFocusedWindow() ?? window;
  if (!target) return;
  target.webContents.send(CHANNELS.command, action);
}

/**
 * Headless smoke check: screenshot the window and report the MCP endpoint, then
 * quit (or stay alive for further probing when `PIXEL_SMOKE_KEEP=1`).
 *
 * Used by CI and by hand to prove the app actually boots and paints, which a
 * passing build does not.
 */
async function smokeTest(created: BrowserWindow, target: string): Promise<void> {
  // `PIXEL_SMOKE_SIZE=1280x800` shoots a second frame at another size, which is
  // how the responsive breakpoints get checked without a human resizing.
  const size = process.env.PIXEL_SMOKE_SIZE;
  if (created.webContents.isLoading()) {
    await new Promise<void>((resolve) => created.webContents.once('did-finish-load', () => resolve()));
  }
  // Let React mount, fetch the first preview and paint a frame.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const image = await created.webContents.capturePage();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, image.toPNG());
  if (size) {
    const [w, h] = size.split('x').map(Number);
    if (w && h) {
      created.setSize(w, h);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const resized = await created.webContents.capturePage();
      await writeFile(target.replace(/\.png$/, `-${w}x${h}.png`), resized.toPNG());
    }
  }
  await writeFile(
    `${target}.mcp.txt`,
    JSON.stringify({ url: mcpStatus.url, running: mcpStatus.running }, null, 2),
  );
  console.error(`[dotloom-mcp] smoke screenshot: ${target}`);
  console.error(`[dotloom-mcp] smoke mcp: ${mcpStatus.url ?? 'not running'}`);
  if (process.env.PIXEL_SMOKE_KEEP !== '1') app.quit();
}

async function start(): Promise<void> {
  // A starter document so the app is never an empty window.
  if (store.list().length === 0) {
    store.create({
      width: 32,
      height: 32,
      name: 'Sprite',
      layers: ['base', 'shade', 'outline'],
      palette: 'dawnbringer16',
    });
  }

  registerIpc(() => mcpStatus);
  window = createWindow();

  try {
    mcp = await startMcpHost(Number(process.env.PIXEL_MCP_PORT ?? DEFAULT_MCP_PORT));
    mcpStatus = mcp.status();
    if (mcpStatus.url) {
      console.error(`[dotloom-mcp] MCP server listening on ${mcpStatus.url}`);
      // Publish the endpoint so an installed `dotloom-mcp` finds this app on its
      // own. It cannot be configured client-side: the port is only known after
      // the retry loop picks one, and a client config holding a stale port fails
      // silently rather than loudly.
      const file = await writeHostFile({
        url: mcpStatus.url,
        port: mcpStatus.port ?? DEFAULT_MCP_PORT,
        pid: process.pid,
        startedAt: Date.now(),
      });
      console.error(`[dotloom-mcp] published ${file}`);
    }
  } catch (error) {
    mcpStatus = {
      running: false,
      error: error instanceof Error ? error.message : String(error),
    };
    console.error('[dotloom-mcp] MCP server failed to start:', mcpStatus.error);
  }

  if (process.env.PIXEL_SMOKE && window) {
    void smokeTest(window, process.env.PIXEL_SMOKE);
  }
}

if (!app.requestSingleInstanceLock()) {
  // A previous run is still alive (very common on Windows, where closing the
  // terminal does not always deliver SIGINT to the dev launcher, so electron.exe
  // lingers). The existing instance was focused by its `second-instance` handler.
  console.error(
    '[dotloom-mcp] another instance is already running — focusing it instead of opening a second window.',
  );
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  // No application menu anywhere: the renderer draws its own bar, so the
  // accelerators the menu used to host are claimed per window instead.
  Menu.setApplicationMenu(null);

  ipcMain.handle(CHANNELS.windowCommand, (_event, action: string) => {
    const target = BrowserWindow.fromWebContents(_event.sender) ?? window;
    if (!target) return;
    if (action === 'minimize') target.minimize();
    else if (action === 'maximize') target.maximize();
    else if (action === 'unmaximize') target.unmaximize();
    else if (action === 'close') target.close();
  });

  app.whenReady().then(start).catch((error) => {
    console.error(error);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void mcp?.close();
    // Leave no record pointing at a port that is about to stop answering.
    void removeHostFile();
  });
}
