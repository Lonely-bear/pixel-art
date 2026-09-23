import type { Rect } from './types.js';

/**
 * Rect helpers. Rectangles may be constructed "backwards" (negative `w`/`h`) by callers
 * dragging a selection, so every helper normalises first.
 *
 * All helpers clamp to the target surface; nothing here ever throws on out-of-bounds,
 * because an AI agent passing a slightly-too-large rect should get a clipped result
 * rather than a hard failure.
 */

export function normalizeRect(rect: Rect): Rect {
  return {
    x: Math.min(rect.x, rect.x + rect.w),
    y: Math.min(rect.y, rect.y + rect.h),
    w: Math.abs(rect.w),
    h: Math.abs(rect.h),
  };
}

export function clipRect(rect: Rect, width: number, height: number): Rect {
  const n = normalizeRect(rect);
  const x0 = Math.max(0, Math.min(width, n.x));
  const y0 = Math.max(0, Math.min(height, n.y));
  const x1 = Math.max(0, Math.min(width, n.x + n.w));
  const y1 = Math.max(0, Math.min(height, n.y + n.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function expandRect(rect: Rect, by: number, width: number, height: number): Rect {
  return clipRect({ x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 }, width, height);
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}

export function rectIsEmpty(rect: Rect): boolean {
  return rect.w <= 0 || rect.h <= 0;
}

export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return normalizeRect({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
}

export function fullRect(width: number, height: number): Rect {
  return { x: 0, y: 0, w: width, h: height };
}
