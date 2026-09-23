import type { PixelApi } from '../shared/types.js';

declare global {
  interface Window {
    pixel: PixelApi;
  }
}

/**
 * The renderer's only door to the outside world. Everything else in `src/` is
 * pure UI state; every mutation goes through the command bus in the main
 * process, exactly like an agent's tool call would.
 */
export const api: PixelApi = window.pixel;
