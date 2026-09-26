/**
 * Which builds can update themselves, decided without touching Electron.
 *
 * The order matters and is the whole point of this file. Checked from most
 * specific to most general, so the *first* reason is the one that actually
 * explains the situation to the user: a dev run of a portable target is a dev
 * run, and saying "portable" there would be a lie about why nothing happens.
 *
 * Deliberately free of `electron` imports so it can be unit-tested directly.
 * The main process passes in the four facts it has; nothing here reads a global.
 */
import type { UpdateUnavailableReason } from '../shared/types.js';

export interface UpdateSupportInput {
  /** `app.isPackaged` — false under `pnpm dev`, true in an unpacked build too. */
  packaged: boolean;
  platform: NodeJS.Platform;
  /** electron-builder's portable target sets this for the exe it unpacks. */
  portable: boolean;
  /** An AppImage sets `APPIMAGE` to its own path. */
  appImage: boolean;
  /** Whether the packaging run had a certificate (injected at build time). */
  codeSigned: boolean;
}

export type UpdateSupport = { supported: true } | { supported: false; reason: UpdateUnavailableReason };

export function resolveUpdateSupport(input: UpdateSupportInput): UpdateSupport {
  // An unpackaged run has no installer to replace and no `app-update.yml` to
  // read, so the updater would fail on the very first request.
  if (!input.packaged) return { supported: false, reason: 'dev' };

  // A portable exe is a single file the user keeps wherever they like. Updating
  // it would mean writing into that folder, which is the one thing the target
  // exists to avoid.
  if (input.portable) return { supported: false, reason: 'portable' };

  // macOS replaces the bundle through Squirrel.Mac, which refuses an application
  // whose signature is not the one it expects. An ad-hoc signature is
  // re-derived on every build, so *no* update would ever verify. This is the one
  // platform where "it is not signed" means "it cannot self-update" rather than
  // "the user will see a warning".
  if (input.platform === 'darwin' && !input.codeSigned) {
    return { supported: false, reason: 'unsigned-mac' };
  }

  // On Linux the updater replaces an AppImage in place. A .deb belongs to the
  // system package manager, and downloading a second copy of the app next to it
  // would leave two versions fighting over the same desktop entry.
  if (input.platform === 'linux' && !input.appImage) {
    return { supported: false, reason: 'package-manager' };
  }

  return { supported: true };
}

/** Human-readable reason for the console, which has no translations. */
export function describeSupport(support: UpdateSupport): string {
  return support.supported ? 'self-updating' : `cannot self-update: ${support.reason}`;
}
