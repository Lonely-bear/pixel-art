/**
 * The update preferences, as data.
 *
 * Split out of `settings.ts` because that module touches `app.getPath` and
 * therefore cannot be imported outside a running Electron. The parsing is the
 * part worth testing — a hand-edited or half-written `settings.json` must cost
 * one field, not the whole file — and a module that cannot be imported cannot be
 * tested at all.
 */
import type { UpdateSettings } from '../shared/types.js';

/**
 * On by default. A pixel-art editor is not something a user opens every day, so
 * a quiet check is the only way they hear about a fix; what it will *not* do is
 * download anything, which is the decision a user should always make themselves.
 */
export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { autoCheck: true };

/** Tolerant reader: one bad field falls back on its own, the rest survive. */
export function parseUpdateSettings(raw: string | null): UpdateSettings {
  if (!raw) return { ...DEFAULT_UPDATE_SETTINGS };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_UPDATE_SETTINGS };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_UPDATE_SETTINGS };
  }

  const value = parsed as Partial<UpdateSettings>;
  const settings: UpdateSettings = {
    autoCheck:
      typeof value.autoCheck === 'boolean' ? value.autoCheck : DEFAULT_UPDATE_SETTINGS.autoCheck,
  };
  if (typeof value.skippedVersion === 'string' && value.skippedVersion) {
    settings.skippedVersion = value.skippedVersion;
  }
  if (typeof value.lastCheckedAt === 'number' && Number.isFinite(value.lastCheckedAt)) {
    settings.lastCheckedAt = value.lastCheckedAt;
  }
  if (typeof value.notesVersion === 'string' && value.notesVersion) {
    settings.notesVersion = value.notesVersion;
  }
  if (typeof value.notesBody === 'string' && value.notesBody) {
    settings.notesBody = value.notesBody;
  }
  return settings;
}
