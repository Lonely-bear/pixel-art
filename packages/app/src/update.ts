/**
 * The renderer's view of the updater.
 *
 * Everything lives in the main process, so this is a thin cache: one snapshot,
 * one subscription, and whatever the main process pushed since. Both consumers
 * — the banner over the canvas and the settings panel — read the same object,
 * which is what keeps them from telling the user two different things.
 *
 * Note there is no "is an update available" boolean in here. The main process
 * decides that, including the part the user controls by skipping a version, and
 * a second opinion kept in the renderer would be a second chance to disagree.
 */
import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { UpdateSnapshot } from '../shared/types.js';

/**
 * Survives a remount, so opening the settings panel after closing a banner does
 * not flash the previous state back before the new snapshot arrives.
 */
let cached: UpdateSnapshot | null = null;
let started = false;

function start(): void {
  if (started) return;
  started = true;
  api.onUpdateEvent((event) => {
    if (!cached) return;
    cached = { ...cached, settings: event.settings, state: event.state };
  });
}

export function useUpdateSnapshot(): UpdateSnapshot | null {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(cached);

  useEffect(() => {
    let alive = true;
    start();
    // A window created after an update was found still has to be told: the
    // banner was never mounted when the event fired.
    void api.updateSnapshot().then((next) => {
      if (!alive) return;
      cached = next;
      setSnapshot(next);
    });
    return api.onUpdateEvent((event) => {
      if (!alive || !cached) return;
      const next = { ...cached, settings: event.settings, state: event.state };
      cached = next;
      setSnapshot(next);
    });
  }, []);

  return snapshot;
}

/** Bytes as megabytes, because that is the unit a download decision is made in. */
export function megabytes(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  return (bytes / (1024 * 1024)).toFixed(1);
}
