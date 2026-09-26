/**
 * The two pieces of updater logic that can be reasoned about without a running
 * Electron: which builds may update themselves, and how a preferences file is
 * read back.
 *
 * Both exist as separate modules from their `electron` importers for exactly
 * this reason — `updater.ts` wires a singleton to real events, and what is
 * worth checking here is the set of decisions made *before* any of that.
 */
import { describe, expect, it } from 'vitest';
import { resolveUpdateSupport, describeSupport, type UpdateSupportInput } from './update-support.js';
import { parseUpdateSettings } from './update-settings.js';

function input(overrides: Partial<UpdateSupportInput> = {}): UpdateSupportInput {
  return {
    packaged: true,
    platform: 'win32',
    portable: false,
    appImage: false,
    codeSigned: true,
    ...overrides,
  };
}

describe('resolveUpdateSupport', () => {
  it('allows the targets that can be replaced in place', () => {
    expect(resolveUpdateSupport(input({ platform: 'win32' }))).toEqual({ supported: true });
    expect(resolveUpdateSupport(input({ platform: 'darwin' }))).toEqual({ supported: true });
    expect(resolveUpdateSupport(input({ platform: 'linux', appImage: true }))).toEqual({
      supported: true,
    });
  });

  it('refuses an unpackaged run before anything else is asked', () => {
    // Portable and unsigned are both true here, and none of them is the reason:
    // a dev run has no installer to replace in the first place.
    expect(resolveUpdateSupport(input({ packaged: false, portable: true }))).toEqual({
      supported: false,
      reason: 'dev',
    });
  });

  it('refuses a portable build', () => {
    expect(resolveUpdateSupport(input({ portable: true }))).toEqual({
      supported: false,
      reason: 'portable',
    });
  });

  it('refuses macOS only when the build is unsigned', () => {
    expect(resolveUpdateSupport(input({ platform: 'darwin', codeSigned: false }))).toEqual({
      supported: false,
      reason: 'unsigned-mac',
    });
    // An unsigned Windows build still updates; the user just sees a warning
    // the first time the new one starts.
    expect(resolveUpdateSupport(input({ platform: 'win32', codeSigned: false }))).toEqual({
      supported: true,
    });
  });

  it('refuses a Linux install that is not an AppImage', () => {
    expect(resolveUpdateSupport(input({ platform: 'linux', appImage: false }))).toEqual({
      supported: false,
      reason: 'package-manager',
    });
  });

  it('names the reason in the console line', () => {
    expect(describeSupport({ supported: true })).toBe('self-updating');
    expect(describeSupport({ supported: false, reason: 'portable' })).toContain('portable');
  });
});

describe('parseUpdateSettings', () => {
  it('defaults to checking automatically with nothing skipped', () => {
    expect(parseUpdateSettings(null)).toEqual({ autoCheck: true });
    expect(parseUpdateSettings('not json at all')).toEqual({ autoCheck: true });
    expect(parseUpdateSettings('[]')).toEqual({ autoCheck: true });
    expect(parseUpdateSettings('"a string"')).toEqual({ autoCheck: true });
  });

  it('reads back what it wrote', () => {
    const stored = {
      autoCheck: false,
      skippedVersion: '0.5.0',
      lastCheckedAt: 1_700_000_000_000,
      notesVersion: '0.5.0',
      notesBody: 'Faster tiles.',
    };
    expect(parseUpdateSettings(JSON.stringify(stored))).toEqual(stored);
  });

  it('loses one bad field and keeps the rest', () => {
    const parsed = parseUpdateSettings(
      JSON.stringify({ autoCheck: 'yes', skippedVersion: 7, lastCheckedAt: Number.NaN }),
    );
    // A string where a boolean belongs falls back; so does a non-finite time.
    expect(parsed.autoCheck).toBe(true);
    expect(parsed.skippedVersion).toBeUndefined();
    expect(parsed.lastCheckedAt).toBeUndefined();
  });

  it('drops empty strings rather than storing a blank version', () => {
    const parsed = parseUpdateSettings(JSON.stringify({ skippedVersion: '', notesBody: '' }));
    expect(parsed.skippedVersion).toBeUndefined();
    expect(parsed.notesBody).toBeUndefined();
  });
});
