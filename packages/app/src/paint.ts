/**
 * Local stroke preview.
 *
 * `@pixel/core` is pure TypeScript with no platform dependencies, so the
 * renderer can use the *same* rasteriser the main process will use to commit the
 * stroke. The preview is therefore pixel-exact rather than an approximation —
 * what you see while dragging is what gets committed.
 *
 * Nothing here mutates the document. The preview buffer is thrown away on
 * pointer-up and the real edit is sent as a single command, so one stroke is one
 * undo step.
 */
import {
  PixelBuffer,
  drawEllipse,
  drawRect,
  type Color,
  type Point,
  type Rect,
} from '@pixel/core';

/** Marker colour for an erase preview: the overlay cannot show transparency. */
export const ERASE_PREVIEW: Color = { r: 255, g: 0, b: 255, a: 170 };

export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
}

/** Integer Bresenham, so thickness is applied to exact pixel centres. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  const points: Point[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    points.push({ x, y });
    if (x === x1 && y === y1) break;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
  return points;
}

function stamp(buffer: PixelBuffer, x: number, y: number, size: number, color: Color): void {
  if (size <= 1) {
    buffer.setColor(x, y, color);
    return;
  }
  const offset = Math.floor((size - 1) / 2);
  for (let dy = 0; dy < size; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      const px = x - offset + dx;
      const py = y - offset + dy;
      if (px >= 0 && py >= 0 && px < buffer.width && py < buffer.height) {
        buffer.setColor(px, py, color);
      }
    }
  }
}

export function stampLine(
  buffer: PixelBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
  color: Color,
): void {
  for (const point of linePoints(x0, y0, x1, y1)) stamp(buffer, point.x, point.y, size, color);
}

export function stampPoint(buffer: PixelBuffer, x: number, y: number, size: number, color: Color): void {
  stamp(buffer, x, y, size, color);
}

/** Points with any opacity, row-major. */
export function opaquePoints(buffer: PixelBuffer): Point[] {
  const points: Point[] = [];
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      if (buffer.getColor(x, y).a > 0) points.push({ x, y });
    }
  }
  return points;
}

/** Grow a 1px preview shape into a `size`-wide brush stroke. */
export function thicken(buffer: PixelBuffer, size: number, color: Color): void {
  if (size <= 1) return;
  const points = opaquePoints(buffer);
  buffer.clear();
  for (const point of points) stamp(buffer, point.x, point.y, size, color);
}

export interface ShapeRequest {
  tool: 'line' | 'rect' | 'ellipse';
  from: Point;
  to: Point;
  fill: boolean;
}

/** Redraw `buffer` as the preview for `request`. */
export function drawShapePreview(
  buffer: PixelBuffer,
  request: ShapeRequest,
  size: number,
  color: Color,
): void {
  buffer.clear();
  if (request.tool === 'line') {
    stampLine(buffer, request.from.x, request.from.y, request.to.x, request.to.y, size, color);
    return;
  }
  const rect = rectFromPoints(request.from, request.to);
  if (request.tool === 'rect') drawRect(buffer, rect, color, { fill: request.fill });
  else drawEllipse(buffer, rect, color, { fill: request.fill });
  thicken(buffer, size, color);
}

/** Pack a preview buffer into RGBA bytes for `ImageData`. */
export function toImageData(buffer: PixelBuffer): ImageData {
  // `data` is already straight-alpha RGBA in the layout ImageData expects.
  return new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height);
}
