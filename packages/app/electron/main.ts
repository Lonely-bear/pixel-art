import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { removeHostFile, writeHostFile } from '@pixel/mcp';
import { CHANNELS, type AppLocale } from '../shared/types.js';
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
    backgroundColor: '#f4f4f1',
    title: 'dotloom-mcp',
    show: false,
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

  if (devServer) {
    void created.loadURL(devServer);
  } else {
    void created.loadFile(path.join(here, '..', 'renderer', 'index.html'));
  }

  return created;
}

const MENU_TEXT = {
  en: {
    file: 'File', newSprite: 'New sprite', open: 'Open…', save: 'Save',
    exportPng: 'Export PNG…', exportSheet: 'Export spritesheet…', edit: 'Edit',
    undo: 'Undo', redo: 'Redo', view: 'View',
  },
  'zh-CN': {
    file: '文件', newSprite: '新建角色', open: '打开…', save: '保存',
    exportPng: '导出 PNG…', exportSheet: '导出精灵图…', edit: '编辑',
    undo: '撤销', redo: '重做', view: '视图',
  },
} as const;

function buildMenu(locale: AppLocale = 'en'): void {
  const text = MENU_TEXT[locale];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: text.file,
        submenu: [
          {
            label: text.newSprite,
            accelerator: 'CmdOrCtrl+N',
            click: () => window?.webContents.send('pixel:menu', 'new'),
          },
          {
            label: text.open,
            accelerator: 'CmdOrCtrl+O',
            click: () => window?.webContents.send('pixel:menu', 'open'),
          },
          { type: 'separator' },
          {
            label: text.save,
            accelerator: 'CmdOrCtrl+S',
            click: () => window?.webContents.send('pixel:menu', 'save'),
          },
          {
            label: text.exportPng,
            accelerator: 'CmdOrCtrl+E',
            click: () => window?.webContents.send('pixel:menu', 'export'),
          },
          {
            label: text.exportSheet,
            accelerator: 'CmdOrCtrl+Shift+E',
            click: () => window?.webContents.send('pixel:menu', 'sheet'),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: text.edit,
        submenu: [
          {
            label: text.undo,
            accelerator: 'CmdOrCtrl+Z',
            click: () => window?.webContents.send('pixel:menu', 'undo'),
          },
          {
            label: text.redo,
            accelerator: 'CmdOrCtrl+Shift+Z',
            click: () => window?.webContents.send('pixel:menu', 'redo'),
          },
        ],
      },
      {
        label: text.view,
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
  ipcMain.on(CHANNELS.setLocale, (_event, locale: AppLocale) => {
    if (locale === 'en' || locale === 'zh-CN') buildMenu(locale);
  });
  buildMenu();
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
