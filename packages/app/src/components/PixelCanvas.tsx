import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PixelBuffer, type Point } from '@pixel/core';
import { useEditor, sampleColor } from '../editor-context.js';
import { ERASE_PREVIEW, drawShapePreview, opaquePoints, stampLine, stampPoint } from '../paint.js';
import { rgbaToHex, rgbaToCss } from '../color-utils.js';

interface Stroke {
  tool: string;
  color: { r: number; g: number; b: number; a: number };
  erase: boolean;
  start: Point;
  last: Point;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 40;

export function PixelCanvas(): React.ReactNode {
  const editor = useEditor();
  const { detail, bitmap, zoom, setZoom, tool, primary, secondary, brushSize, fillShapes } = editor;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<PixelBuffer | null>(null);
  const overlayDirty = useRef(true);
  const strokeRef = useRef<Stroke | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [redrawCount, forceRedraw] = useState(0);
  const fittedFor = useRef<string | null>(null);

  const width = detail?.width ?? 0;
  const height = detail?.height ?? 0;

  const redraw = useCallback(() => forceRedraw((n) => n + 1), []);

  // Track the wrapper size.
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewport({ w: element.clientWidth, h: element.clientHeight });
    });
    observer.observe(element);
    setViewport({ w: element.clientWidth, h: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(
    (docWidth: number, docHeight: number) => {
      if (!viewport.w || !viewport.h || !docWidth || !docHeight) return;
      const factor = Math.floor(
        Math.min((viewport.w - 48) / docWidth, (viewport.h - 48) / docHeight),
      );
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, factor || 1));
      setZoom(next);
      panRef.current = {
        x: Math.round((viewport.w - docWidth * next) / 2),
        y: Math.round((viewport.h - docHeight * next) / 2),
      };
      redraw();
    },
    [viewport.w, viewport.h, setZoom, redraw],
  );

  // Fit once per document size, and whenever the window is resized while the
  // document has never been panned.
  useEffect(() => {
    if (!detail || !viewport.w) return;
    const key = `${detail.id}:${detail.width}x${detail.height}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    fit(detail.width, detail.height);
  }, [detail, viewport.w, fit]);

  // ---- rendering -----------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(viewport.w * dpr));
    canvas.height = Math.max(1, Math.round(viewport.h * dpr));
    canvas.style.width = `${viewport.w}px`;
    canvas.style.height = `${viewport.h}px`;
    const context = canvas.getContext('2d');
    if (!context) return;

    const { x: panX, y: panY } = panRef.current;
    const imageWidth = width * zoom;
    const imageHeight = height * zoom;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, viewport.w, viewport.h);
    context.imageSmoothingEnabled = false;

    // Transparency checkerboard, clipped to the image.
    context.save();
    context.beginPath();
    context.rect(panX, panY, imageWidth, imageHeight);
    context.clip();
    context.fillStyle = checkerPattern(context);
    context.fillRect(panX, panY, imageWidth, imageHeight);
    if (bitmap) context.drawImage(bitmap, panX, panY, imageWidth, imageHeight);

    // In-progress stroke overlay.
    const overlay = overlayRef.current;
    if (overlay) {
      let surface = overlayCanvasRef.current;
      if (!surface || surface.width !== overlay.width || surface.height !== overlay.height) {
        surface = document.createElement('canvas');
        surface.width = overlay.width;
        surface.height = overlay.height;
        overlayCanvasRef.current = surface;
        overlayDirty.current = true;
      }
      if (overlayDirty.current) {
        const surfaceContext = surface.getContext('2d');
        surfaceContext?.clearRect(0, 0, surface.width, surface.height);
        surfaceContext?.putImageData(
          new ImageData(new Uint8ClampedArray(overlay.data), overlay.width, overlay.height),
          0,
          0,
        );
        overlayDirty.current = false;
      }
      context.drawImage(surface, panX, panY, imageWidth, imageHeight);
    }
    context.restore();

    // Pixel grid, once pixels are big enough to aim at.
    if (zoom >= 8) {
      context.strokeStyle = 'rgba(255,255,255,0.07)';
      context.lineWidth = 1;
      context.beginPath();
      for (let x = 0; x <= width; x += 1) {
        const sx = Math.round(panX + x * zoom) + 0.5;
        context.moveTo(sx, panY);
        context.lineTo(sx, panY + imageHeight);
      }
      for (let y = 0; y <= height; y += 1) {
        const sy = Math.round(panY + y * zoom) + 0.5;
        context.moveTo(panX, sy);
        context.lineTo(panX + imageWidth, sy);
      }
      context.stroke();

      // A stronger line every 8 pixels, which is the usual sprite grid.
      context.strokeStyle = 'rgba(255,255,255,0.14)';
      context.beginPath();
      for (let x = 0; x <= width; x += 8) {
        const sx = Math.round(panX + x * zoom) + 0.5;
        context.moveTo(sx, panY);
        context.lineTo(sx, panY + imageHeight);
      }
      for (let y = 0; y <= height; y += 8) {
        const sy = Math.round(panY + y * zoom) + 0.5;
        context.moveTo(panX, sy);
        context.lineTo(panX + imageWidth, sy);
      }
      context.stroke();
    }

    // Canvas border.
    context.strokeStyle = 'rgba(255,255,255,0.25)';
    context.lineWidth = 1;
    context.strokeRect(panX - 0.5, panY - 0.5, imageWidth + 1, imageHeight + 1);

    // Brush footprint under the cursor.
    const cursor = editor.cursor;
    if (cursor && zoom >= 2 && tool !== 'pan') {
      const offset = Math.floor((brushSize - 1) / 2);
      context.fillStyle =
        tool === 'eraser' ? 'rgba(255,0,255,0.35)' : rgbaToCss(primary, 0.35);
      context.fillRect(
        panX + (cursor.x - offset) * zoom,
        panY + (cursor.y - offset) * zoom,
        brushSize * zoom,
        brushSize * zoom,
      );
      context.strokeStyle = 'rgba(255,255,255,0.9)';
      context.strokeRect(
        panX + (cursor.x - offset) * zoom + 0.5,
        panY + (cursor.y - offset) * zoom + 0.5,
        brushSize * zoom - 1,
        brushSize * zoom - 1,
      );
    }
  }, [bitmap, zoom, viewport, width, height, editor.cursor, tool, primary, brushSize, panning, redrawCount]);

  // ---- coordinate helpers --------------------------------------------------

  const toPixel = useCallback(
    (event: React.PointerEvent | React.WheelEvent): Point => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const { x: panX, y: panY } = panRef.current;
      return {
        x: Math.floor((event.clientX - rect.left - panX) / zoom),
        y: Math.floor((event.clientY - rect.top - panY) / zoom),
      };
    },
    [zoom],
  );

  const ensureOverlay = useCallback((): PixelBuffer => {
    let overlay = overlayRef.current;
    if (!overlay || overlay.width !== width || overlay.height !== height) {
      overlay = new PixelBuffer(width, height);
      overlayRef.current = overlay;
    }
    return overlay;
  }, [width, height]);

  // ---- pointer interaction -------------------------------------------------

  const beginPan = useCallback((event: React.PointerEvent) => {
    setPanning(true);
    const start = { x: event.clientX, y: event.clientY };
    const origin = { ...panRef.current };
    const move = (moveEvent: PointerEvent) => {
      panRef.current = {
        x: origin.x + (moveEvent.clientX - start.x),
        y: origin.y + (moveEvent.clientY - start.y),
      };
      forceRedraw((n) => n + 1);
    };
    const up = () => {
      setPanning(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!detail) return;
      const point = toPixel(event);

      if (tool === 'pan' || event.button === 1 || event.altKey) {
        event.preventDefault();
        beginPan(event);
        return;
      }

      if (tool === 'eyedropper') {
        const sampled = bitmap ? sampleColor(bitmap, point.x, point.y) : null;
        if (sampled) editor.setPrimary(sampled);
        return;
      }

      const useSecondary = event.button === 2;
      const color = useSecondary ? secondary : primary;
      const erase = tool === 'eraser';

      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();

      const overlay = ensureOverlay();
      overlay.clear();

      strokeRef.current = {
        tool,
        color,
        erase,
        start: point,
        last: point,
      };

      const previewColor = erase ? ERASE_PREVIEW : color;

      if (tool === 'pencil' || tool === 'eraser') {
        stampPoint(overlay, point.x, point.y, brushSize, previewColor);
      } else if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
        drawShapePreview(
          overlay,
          { tool, from: point, to: point, fill: fillShapes },
          brushSize,
          previewColor,
        );
      } else {
        // Fill, replace and outline act on the layer's own pixels, which the
        // renderer does not hold a copy of. Commit immediately.
        overlayRef.current = null;
        strokeRef.current = null;
        void commitClickTool(tool, point, color);
        return;
      }

      overlayDirty.current = true;
      redraw();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail, tool, toPixel, beginPan, bitmap, primary, secondary, brushSize, fillShapes, ensureOverlay, redraw],
  );

  const commitClickTool = useCallback(
    async (activeTool: string, point: Point, color: { r: number; g: number; b: number; a: number }) => {
      const layer = editor.layerId;
      const frame = editor.frameId;
      if (!layer || !frame) return;
      const hex = rgbaToHex(color);
      if (activeTool === 'fill') {
        await editor.execute('fill', { layer, frame, x: point.x, y: point.y, color: hex, contiguous: true });
      } else if (activeTool === 'replace') {
        const target = editor.hoverColor ?? color;
        await editor.execute('replace_color', { layer, frame, from: rgbaToHex(target), to: hex });
      }
    },
    [editor],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = toPixel(event);
      editor.setCursor(point);
      const stroke = strokeRef.current;
      if (!stroke) return;
      const overlay = overlayRef.current;
      if (!overlay) return;

      const previewColor = stroke.erase ? ERASE_PREVIEW : stroke.color;

      if (stroke.tool === 'pencil' || stroke.tool === 'eraser') {
        stampLine(overlay, stroke.last.x, stroke.last.y, point.x, point.y, brushSize, previewColor);
        stroke.last = point;
      } else if (stroke.tool === 'line' || stroke.tool === 'rect' || stroke.tool === 'ellipse') {
        drawShapePreview(
          overlay,
          { tool: stroke.tool as 'line' | 'rect' | 'ellipse', from: stroke.start, to: point, fill: fillShapes },
          brushSize,
          previewColor,
        );
      }
      overlayDirty.current = true;
      redraw();
    },
    [toPixel, editor, brushSize, fillShapes, redraw],
  );

  const onPointerUp = useCallback(
    async (event: React.PointerEvent<HTMLCanvasElement>) => {
      const stroke = strokeRef.current;
      const overlay = overlayRef.current;
      strokeRef.current = null;
      if (!stroke || !overlay) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const points = opaquePoints(overlay);
      overlay.clear();
      overlayDirty.current = true;
      redraw();
      if (points.length === 0) return;

      const layer = editor.layerId;
      const frame = editor.frameId;
      if (!layer || !frame) return;

      const color = stroke.erase ? null : rgbaToHex(stroke.color);
      await editor.execute('draw_pixels', {
        layer,
        frame,
        pixels: points.map((point) => ({ x: point.x, y: point.y, color })),
      });
    },
    [editor, redraw],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const { x: panX, y: panY } = panRef.current;
      const before = {
        x: (pointerX - panX) / zoom,
        y: (pointerY - panY) / zoom,
      };
      const direction = event.deltaY < 0 ? 1 : -1;
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + direction));
      if (next === zoom) return;
      panRef.current = {
        x: Math.round(pointerX - before.x * next),
        y: Math.round(pointerY - before.y * next),
      };
      setZoom(next);
    },
    [zoom, setZoom],
  );

  return (
    <div className="canvas-wrap" ref={wrapperRef}>
      <canvas
        ref={canvasRef}
        className={`pixel-canvas tool-${tool}${panning ? ' panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => editor.setCursor(null)}
        onWheel={onWheel}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div className="canvas-actions">
        <button type="button" onClick={() => fit(width, height)} title="Fit to window">
          Fit
        </button>
        <button type="button" onClick={() => setZoom(1)} title="Reset zoom to 100%">
          1:1
        </button>
        <span className="zoom-label">{zoom}x</span>
      </div>
    </div>
  );
}

function checkerPattern(context: CanvasRenderingContext2D): CanvasPattern | string {
  if (!checkerCache) {
    const tile = document.createElement('canvas');
    tile.width = 16;
    tile.height = 16;
    const tileContext = tile.getContext('2d');
    if (!tileContext) return '#20242d';
    tileContext.fillStyle = '#1a1d24';
    tileContext.fillRect(0, 0, 16, 16);
    tileContext.fillStyle = '#22262f';
    tileContext.fillRect(0, 0, 8, 8);
    tileContext.fillRect(8, 8, 8, 8);
    checkerCache = tile;
  }
  return context.createPattern(checkerCache, 'repeat') ?? '#1a1d24';
}

let checkerCache: HTMLCanvasElement | null = null;
