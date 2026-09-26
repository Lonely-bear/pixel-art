/**
 * Everything about self-updating, in one module.
 *
 * Design notes worth knowing before changing anything here:
 *
 * - **The main process owns the state machine.** The renderer sends intents
 *   (check, download, install) and renders whatever snapshot comes back. That
 *   is the same shape as everything else in this app: the GUI is not a
 *   privileged client, and the only thing it can do with an update is ask for
 *   one.
 * - **Check, never download, unasked.** `autoDownload` is off and a background
 *   check is silent about failure. An editor is used on whatever connection the
 *   machine happens to have, and a hundred-megabyte surprise is not a feature.
 * - **Scheduling is deliberately unhurried.** The first check lands somewhere
 *   between 30 seconds and 5 minutes after launch, and then every six hours,
 *   because a GitHub release lookup is an unauthenticated API call and every
 *   installed copy shares one rate limit per IP.
 * - **Never restart without asking.** `quitAndInstall` throws away the
 *   process, and a sprite with no file behind it would go with it. The
 *   confirmation that guards that lives here rather than in the renderer,
 *   because only this side knows which documents have unsaved edits.
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import {
  CHANNELS,
  type AppLocale,
  type UpdateEvent,
  type UpdateSettings,
  type UpdateSnapshot,
  type UpdateState,
} from '../shared/types.js';
import { store } from './host.js';
import { readUpdateSettings, writeUpdateSettings } from './settings.js';
import { describeSupport, resolveUpdateSupport, type UpdateSupport } from './update-support.js';

const REPOSITORY = 'https://github.com/Lonely-bear/pixel-art';
const RELEASES_PAGE = `${REPOSITORY}/releases`;
/** Same releases, the REST view — the only one that carries the written notes. */
const RELEASE_API = 'https://api.github.com/repos/Lonely-bear/pixel-art/releases';

/** How often a background check repeats once the first one has happened. */
const BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** The first check waits a while, and not the same while for everyone. */
const FIRST_CHECK_MIN_MS = 30_000;
const FIRST_CHECK_JITTER_MS = 270_000;

let settings: UpdateSettings = { autoCheck: true };
let support: UpdateSupport = { supported: false, reason: 'dev' };
let state: UpdateState = { status: 'idle' };
let currentVersion = '0.0.0';
let codeSigned = false;
let appLocale: AppLocale = 'en';

/**
 * Whether the check in flight was a background one. Read by the `error` handler
 * so a flaky network cannot raise a dialog in a window nobody is looking at.
 */
let checkingInBackground = false;

const dialogText: Record<AppLocale, Record<string, string>> = {
  en: {
    cancel: 'Cancel',
    restart: 'Restart',
    restartAnyway: 'Restart anyway',
    unsavedTitle: 'Unsaved sprites',
    unsavedMessage: 'Some sprites have unsaved changes.',
    unsavedDetail:
      'Installing the update restarts the app, and anything that was never written to a file is lost. Save first, or restart anyway.',
  },
  ja: {
    cancel: 'キャンセル',
    restart: '再起動',
    restartAnyway: 'このまま再起動',
    unsavedTitle: '保存されていないスプライト',
    unsavedMessage: '保存されていない変更があります。',
    unsavedDetail:
      'アップデートをインストールするとアプリは再起動し、ファイルに書き込まれていない内容は失われます。保存してから再起動するか、そのまま再起動してください。',
  },
  ko: {
    cancel: '취소',
    restart: '재시작',
    restartAnyway: '그대로 재시작',
    unsavedTitle: '저장하지 않은 스프라이트',
    unsavedMessage: '저장하지 않은 변경이 있습니다.',
    unsavedDetail:
      '업데이트를 설치하면 앱이 재시작되며 파일에 기록되지 않은 내용은 사라집니다. 저장한 뒤 재시작하거나 그대로 재시작하세요.',
  },
  'zh-CN': {
    cancel: '取消',
    restart: '重启',
    restartAnyway: '仍然重启',
    unsavedTitle: '有未保存的角色',
    unsavedMessage: '部分角色有未保存的修改。',
    unsavedDetail: '安装更新会重启应用，尚未写入文件的画作将会丢失。请先保存，或直接重启。',
  },
  'zh-TW': {
    cancel: '取消',
    restart: '重新啟動',
    restartAnyway: '仍然重新啟動',
    unsavedTitle: '有未儲存的角色',
    unsavedMessage: '部分角色有未儲存的變更。',
    unsavedDetail: '安裝更新會重新啟動應用程式，尚未寫入檔案的畫作將會遺失。請先儲存，或直接重新啟動。',
  },
};

function text(): Record<string, string> {
  return dialogText[appLocale];
}

/**
 * The build-time answer to "was this signed?", injected by `build-main.mjs`.
 *
 * There is no runtime way to ask: macOS only reveals the signature to
 * `codesign`, and the main process is not a macOS tool. The value is baked in
 * next to the code that needs it, from the same environment electron-builder
 * reads its certificates from, so it cannot drift from the artefact.
 */
declare const __PIXEL_CODESIGNED__: boolean;

function push(): void {
  const payload: UpdateEvent = { settings, state };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.updateEvent, payload);
  }
}

function setState(next: UpdateState): void {
  state = next;
  push();
}

export function snapshot(): UpdateSnapshot {
  return {
    currentVersion,
    codeSigned,
    settings,
    state,
    releasePage: RELEASES_PAGE,
  };
}

export function setUpdaterLocale(locale: AppLocale): void {
  appLocale = locale;
}

/**
 * Wire the updater to the app. Called once from `start()`, after `app` is ready
 * and before the first window is created.
 */
export function initUpdater(): void {
  currentVersion = app.getVersion();
  codeSigned = __PIXEL_CODESIGNED__;
  settings = readUpdateSettings();
  support = resolveUpdateSupport({
    packaged: app.isPackaged,
    platform: process.platform,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
    appImage: Boolean(process.env.APPIMAGE),
    codeSigned,
  });

  if (support.supported) {
    state = { status: 'idle' };
    wire();
  } else {
    state = { status: 'unsupported', reason: support.reason };
  }
  console.error(`[dotloom-mcp] updates: ${describeSupport(support)} (v${currentVersion})`);
}

function wire(): void {
  // The three settings that decide whether the app acts on its own. All of them
  // are off: a check that silently downloads is the behaviour people uninstall
  // over, and a silent install is worse.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    void onAvailable(info);
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    void touchCheckedAt();
    setState({ status: 'up-to-date', version: info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    setState({
      status: 'downloading',
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setState({ status: 'ready', version: info.version });
  });

  autoUpdater.on('error', (error: Error) => onError(error));
}

async function touchCheckedAt(): Promise<void> {
  settings = { ...settings, lastCheckedAt: Date.now() };
  await writeUpdateSettings(settings);
}

async function onAvailable(info: UpdateInfo): Promise<void> {
  await touchCheckedAt();

  // A version the user already dismissed stays dismissed until they clear it,
  // so the banner does not come back every six hours for the same release.
  if (settings.skippedVersion === info.version) {
    setState({ status: 'ignored', version: info.version });
    return;
  }

  setState({
    status: 'available',
    version: info.version,
    date: info.releaseDate,
    bytes: info.files?.[0]?.size,
    notes: await releaseNotes(info.version),
  });
}

function onError(error: Error): void {
  const message = error?.message ?? String(error);
  // A background check that hits a captive portal or a sleeping laptop is not
  // an event worth interrupting anyone over; it goes back to idle and the next
  // scheduled check will try again.
  if (checkingInBackground) {
    setState({ status: 'idle' });
    return;
  }
  setState({ status: 'error', message, retryable: true });
}

/**
 * The release notes for a version, fetched once and kept in the settings file.
 *
 * `electron-updater` only tells us a version exists, and "0.5.0 is out" is a
 * much weaker prompt than what changed in it. The body comes from the same
 * release the notes file is attached to, so it is the text the user already saw
 * on the web. A failure here is invisible on purpose: notes are a nicety, and a
 * missing body must not turn a working update into a failure.
 */
async function releaseNotes(version: string): Promise<string | undefined> {
  if (settings.notesVersion === version) return settings.notesBody;
  try {
    const response = await fetch(`${RELEASE_API}/tags/v${version}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dotloom-mcp-updater',
      },
    });
    if (!response.ok) return undefined;
    const release = (await response.json()) as { body?: string | null };
    const body = release.body?.trim();
    settings = { ...settings, notesVersion: version, notesBody: body };
    await writeUpdateSettings(settings);
    return body || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask GitHub what the newest release is.
 *
 * `automatic` changes exactly one thing: whether a failure is reported. Both
 * paths go through the same code, so a background check warms the same caches
 * a manual one would, and a user who clicks "check" sees the real state.
 */
export async function checkForUpdates(automatic = false): Promise<void> {
  if (!support.supported) {
    setState({ status: 'unsupported', reason: support.reason });
    return;
  }
  // Two checks at once would race for the same pending file. A manual click
  // during a check simply waits for the answer already on its way.
  if (state.status === 'checking' || state.status === 'downloading') return;

  checkingInBackground = automatic;
  setState({ status: 'checking' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // The `error` event usually arrives first and has already set the state;
    // this is the belt to that braces, and it is a no-op when it did.
    onError(error instanceof Error ? error : new Error(String(error)));
  } finally {
    checkingInBackground = false;
  }
}

export async function downloadUpdate(): Promise<void> {
  if (!support.supported) return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Restart into the new version, after asking about anything unsaved.
 *
 * The check is here and not in the renderer for one reason: `store` is the
 * authority on whether a document has been written to disk, and the agent can
 * edit a document through MCP while the window is closed. Asking the window
 * would be asking something that might not know.
 */
export async function installUpdate(): Promise<void> {
  if (state.status !== 'ready') return;

  const unsaved = store.list().filter((doc) => doc.dirty).length;
  if (unsaved > 0) {
    const labels = text();
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: labels.unsavedTitle,
      message: labels.unsavedMessage,
      detail: labels.unsavedDetail,
      buttons: [labels.cancel, labels.restartAnyway],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response !== 1) return;
  }

  // Cleared first so the window does not paint a "ready" banner during the
  // hand-off. `isSilent` stays false: the assisted installer is the one the
  // user chose at install time, and its directory page is part of that.
  setState({ status: 'idle' });
  autoUpdater.quitAndInstall(false, true);
}

export async function saveUpdateSettings(patch: Partial<UpdateSettings>): Promise<void> {
  settings = { ...settings, ...patch };
  await writeUpdateSettings(settings);
  push();
}

export async function skipVersion(version: string | null): Promise<void> {
  const next: UpdateSettings = { ...settings };
  if (version) next.skippedVersion = version;
  else delete next.skippedVersion;
  settings = next;
  await writeUpdateSettings(settings);

  // Clearing the skip while it is the reason nothing is showing should show it
  // again, rather than leaving the banner invisible until the next check.
  if (!version && state.status === 'ignored') await checkForUpdates();
  else push();
}

export function openReleasePage(): void {
  void shell.openExternal(RELEASES_PAGE);
}

/**
 * Start the background schedule.
 *
 * The first delay is jittered across five minutes on purpose: every installed
 * copy of a freshly tagged release would otherwise hit the API in the same
 * second, and the first user to be served would be the one whose request got
 * rate-limited.
 */
export function scheduleUpdateChecks(): void {
  if (!support.supported || !settings.autoCheck) return;
  const first = FIRST_CHECK_MIN_MS + Math.random() * FIRST_CHECK_JITTER_MS;
  setTimeout(() => {
    void checkForUpdates(true);
    setInterval(() => void checkForUpdates(true), BACKGROUND_INTERVAL_MS);
  }, first);
}
