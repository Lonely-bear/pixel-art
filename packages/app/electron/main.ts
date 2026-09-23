import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, shell } from 'electron';
import { DEFAULT_MCP_PORT, startMcpHost, type McpHost } from './mcp-host.js';
import { registerIpc } from './ipc.js';
import { store } from './host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const devServer = process.env.PIXEL_DEV_SERVER;

let window: BrowserWindow | undefined;
let mcp: McpHost | undefined;
let mcpStatus: ReturnType<McpHost['status']> = { running: false };

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161c',
    title: 'Pixel Art',
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  created.once('ready-to-show', () => created.show());
  created.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServer) {
    void created.loadURL(devServer);
  } else {
    void created.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  }

  return created;
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          {
            label: 'New sprite',
            accelerator: 'CmdOrCtrl+N',
            click: () => window?.webContents.send('pixel:menu', 'new'),
          },
          {
            label: 'Open…',
            accelerator: 'CmdOrCtrl+O',
            click: () => window?.webContents.send('pixel:menu', 'open'),
          },
          { type: 'separator' },
          {
            label: 'Save',
            accelerator: 'CmdOrCtrl+S',
            click: () => window?.webContents.send('pixel:menu', 'save'),
          },
          {
            label: 'Export PNG…',
            accelerator: 'CmdOrCtrl+E',
            click: () => window?.webContents.send('pixel:menu', 'export'),
          },
          {
            label: 'Export spritesheet…',
            accelerator: 'CmdOrCtrl+Shift+E',
            click: () => window?.webContents.send('pixel:menu', 'sheet'),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          {
            label: 'Undo',
            accelerator: 'CmdOrCtrl+Z',
            click: () => window?.webContents.send('pixel:menu', 'undo'),
          },
          {
            label: 'Redo',
            accelerator: 'CmdOrCtrl+Shift+Z',
            click: () => window?.webContents.send('pixel:menu', 'redo'),
          },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'togglefullscreen' },
        ],
      },
    ]),
  );
}

/**
 * Headless smoke check: screenshot the window and report the MCP endpoint, then
 * quit (or stay alive for further probing when `PIXEL_SMOKE_KEEP=1`).
 *
 * Used by CI and by hand to prove the app actually boots and paints, which a
 * passing build does not.
 */
async function smokeTest(created: BrowserWindow, target: string): Promise<void> {
  if (created.webContents.isLoading()) {
    await new Promise<void>((resolve) => created.webContents.once('did-finish-load', () => resolve()));
  }
  // Let React mount, fetch the first preview and paint a frame.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const image = await created.webContents.capturePage();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, image.toPNG());
  await writeFile(
    `${target}.mcp.txt`,
    JSON.stringify({ url: mcpStatus.url, running: mcpStatus.running }, null, 2),
  );
  console.error(`[pixel-art] smoke screenshot: ${target}`);
  console.error(`[pixel-art] smoke mcp: ${mcpStatus.url ?? 'not running'}`);
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
  buildMenu();
  window = createWindow();

  try {
    mcp = await startMcpHost(Number(process.env.PIXEL_MCP_PORT ?? DEFAULT_MCP_PORT));
    mcpStatus = mcp.status();
    if (mcpStatus.url) {
      console.error(`[pixel-art] MCP server listening on ${mcpStatus.url}`);
    }
  } catch (error) {
    mcpStatus = {
      running: false,
      error: error instanceof Error ? error.message : String(error),
    };
    console.error('[pixel-art] MCP server failed to start:', mcpStatus.error);
  }

  if (process.env.PIXEL_SMOKE && window) {
    void smokeTest(window, process.env.PIXEL_SMOKE);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
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
  });
}
