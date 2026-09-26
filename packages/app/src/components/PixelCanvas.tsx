import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PixelBuffer, type Point } from '@pixel/core';
import { useEditor, sampleColor } from '../editor-context.js';
import { useResolvedTheme } from '../prefs.js';
import { ERASE_PREVIEW, drawShapePreview, opaquePoints, stampLine, stampPoint } from '../paint.js';
import { rgbaToHex, rgbaToCss } from '../color-utils.js';
import { useI18n } from '../i18n.js';
import type { PixelRect } from '../../shared/types.js';
import { Icon } from './Icon.js';

interface Stroke {
  tool: string;
  color: { r: number; g: number; b: number; a: number };
  erase: boolean;
  start: Point;
  last: Point;
}

/** Everything the canvas draws that is not artwork, read from the theme. */
interface CanvasInk {
  checkerA: string;
  checkerB: string;
  grid: string;
  gridStrong: string;
  edge: string;
  eraser: string;
  /** Tint over the pixels the user has boxed. */
  selectionFill: string;
  /** Scrim over everything outside the box, so the box reads as the subject. */
  selectionScrim: string;
  selectionEdge: string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 40;

const FALLBACK_INK: CanvasInk = {
  checkerA: '#f7f7f4',
  checkerB: '#e8e9e5',
  grid: 'rgba(10, 11, 12, 0.14)',
  gridStrong: 'rgba(10, 11, 12, 0.24)',
  edge: 'rgba(10, 11, 12, 0.36)',
  eraser: 'rgba(250, 178, 131, 0.4)',
  selectionFill: 'rgba(96, 150, 255, 0.22)',
  selectionScrim: 'rgba(10, 11, 12, 0.42)',
  selectionEdge: 'rgba(120, 170, 255, 0.95)',
};

/**
 * The rect to draw, which is the live drag while a drag is running and the committed
 * box otherwise. Returns null when there is nothing to show, so the canvas skips the
 * whole scrim pass rather than tinting a zero-area rect.
 */
function boxOf(a: Point, b: Point): PixelRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function PixelCanvas(): React.ReactNode {
  const editor = useEditor();
  const { t } = useI18n();
  const theme = useResolvedTheme();
  const {
    detail,
    bitmap,
    zoom,
    setZoom,
    tool,
    primary,
    secondary,
    brushSize,
    fillShapes,
    onionSkin,
    onionBefore,
    onionAfter,
    sequence,
    frameId,
    thumbnails,
    selection,
  } = editor;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<PixelBuffer | null>(null);
  const overlayDirty = useRef(true);
  const strokeRef = useRef<Stroke | null>(null);
  // The box being dragged, kept local like `strokeRef` until the gesture ends. The
  // committed box lives in the editor context, because the agent has to read it.
  const marqueeRef = useRef<{ origin: Point; current: Point } | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [redrawCount, forceRedraw] = useState(0);
  // Neighbour frames for onion skinning, cached by thumbnail URL so the canvas
  // does not rebuild an image every repaint.
  const onionImages = useRef<Map<string, HTMLImageElement>>(new Map());
  const fittedFor = useRef<string | null>(null);
  const fittedWidth = useRef(0);
  // Set as soon as the user zooms or pans by hand. Until then the canvas keeps
  // re-fitting on resize, so shrinking the window reflows the artboard instead
  // of leaving it cropped; after that their zoom is theirs to keep.
  const userAdjusted = useRef(false);

  const width = detail?.width ?? 0;
  const height = detail?.height ?? 0;

  const redraw = useCallback(() => forceRedraw((n) => n + 1), []);

  // The checkerboard, grid and border are theme colours, not artwork, so they
  // come from the same custom properties as the rest of the UI. Re-read on every
  // theme change and repaint.
  const inkRef = useRef<CanvasInk>(FALLBACK_INK);
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => {
      const value = style.getPropertyValue(name).trim();
      return value || fallback;
    };
    inkRef.current = {
      checkerA: read('--checker-a', FALLBACK_INK.checkerA),
      checkerB: read('--checker-b', FALLBACK_INK.checkerB),
      grid: read('--grid-line', FALLBACK_INK.grid),
      gridStrong: read('--grid-line-strong', FALLBACK_INK.gridStrong),
      edge: read('--canvas-edge', FALLBACK_INK.edge),
      eraser: read('--eraser-preview', FALLBACK_INK.eraser),
      selectionFill: read('--selection-fill', FALLBACK_INK.selectionFill),
      selectionScrim: read('--selection-scrim', FALLBACK_INK.selectionScrim),
      selectionEdge: read('--selection-edge', FALLBACK_INK.selectionEdge),
    };
    checkerCache = null;
    redraw();
  }, [theme, redraw]);

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

  // Fit once per document, and again on every resize until the user takes over.
  useEffect(() => {
    if (!detail || !viewport.w) return;
    if (userAdjusted.current) return;
    const key = `${detail.id}:${detail.width}x${detail.height}`;
    if (fittedFor.current === key && fittedWidth.current === viewport.w) return;
    fittedFor.current = key;
    fittedWidth.current = viewport.w;
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
    context.fillStyle = checkerPattern(context, inkRef.current.checkerA, inkRef.current.checkerB);
    context.fillRect(panX, panY, imageWidth, imageHeight);

    // Onion skin: the neighbouring frames ghosted behind the current one, so a
    // hand-drawn animation can be lined up frame to frame.
    if (onionSkin && sequence && sequence.frameIds.length > 1 && frameId) {
      const total = sequence.frameIds.length;
      const here = sequence.frameIds.indexOf(frameId);
      if (here >= 0) {
        for (let offset = -onionBefore; offset <= onionAfter; offset += 1) {
          if (offset === 0) continue;
          const index = ((here + offset) % total + total) % total;
          const url = thumbnails.get(sequence.frameIds[index]);
          if (!url) continue;
          let image = onionImages.current.get(url);
          if (!image) {
            image = new Image();
            image.src = url;
            onionImages.current.set(url, image);
          }
          if (!image.complete || image.naturalWidth === 0) continue;
          context.globalAlpha = offset < 0 ? 0.35 : 0.25;
          context.drawImage(image, panX, panY, imageWidth, imageHeight);
        }
        context.globalAlpha = 1;
      }
    }

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
      context.strokeStyle = inkRef.current.grid;
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
      context.strokeStyle = inkRef.current.gridStrong;
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
    context.strokeStyle = inkRef.current.edge;
    context.lineWidth = 1;
    context.strokeRect(panX - 0.5, panY - 0.5, imageWidth + 1, imageHeight + 1);

    // The user's box: scrim everything outside it and tint what is inside, so the
    // region they are about to ask about is unmistakable at a glance. Drawn in
    // screen space rather than as pixels so it survives any zoom and never becomes
    // part of the artwork.
    const live = marqueeRef.current;
    const box = live
      ? boxOf(live.origin, live.current)
      : selection && selection.rect.w > 0 && selection.rect.h > 0
        ? selection.rect
        : null;
    if (box) {
      const bx = panX + box.x * zoom;
      const by = panY + box.y * zoom;
      const bw = box.w * zoom;
      const bh = box.h * zoom;

      context.fillStyle = inkRef.current.selectionScrim;
      // Four bands rather than one path with an even-odd fill: a half-transparent
      // fill drawn as a ring would double up on the seams and leave visible edges.
      context.fillRect(panX, panY, imageWidth, Math.max(0, by - panY));
      context.fillRect(panX, by + bh, imageWidth, Math.max(0, panY + imageHeight - (by + bh)));
      context.fillRect(panX, by, Math.max(0, bx - panX), bh);
      context.fillRect(bx + bw, by, Math.max(0, panX + imageWidth - (bx + bw)), bh);

      context.fillStyle = inkRef.current.selectionFill;
      context.fillRect(bx, by, bw, bh);

      context.strokeStyle = inkRef.current.selectionEdge;
      context.lineWidth = Math.max(1, Math.min(2, zoom / 8));
      context.setLineDash(selection?.mode === 'enforce' ? [] : [6, 4]);
      context.strokeRect(
        Math.round(bx) + 0.5,
        Math.round(by) + 0.5,
        Math.max(1, Math.round(bw) - 1),
        Math.max(1, Math.round(bh) - 1),
      );
      context.setLineDash([]);
    }

    // Brush footprint under the cursor.
    const cursor = editor.cursor;
    if (cursor && zoom >= 2 && tool !== 'pan' && tool !== 'select') {
      const offset = Math.floor((brushSize - 1) / 2);
      context.fillStyle = tool === 'eraser' ? inkRef.current.eraser : rgbaToCss(primary, 0.35);
      context.fillRect(
        panX + (cursor.x - offset) * zoom,
        panY + (cursor.y - offset) * zoom,
        brushSize * zoom,
        brushSize * zoom,
      );
      context.strokeStyle = inkRef.current.edge;
      context.strokeRect(
        panX + (cursor.x - offset) * zoom + 0.5,
        panY + (cursor.y - offset) * zoom + 0.5,
        brushSize * zoom - 1,
        brushSize * zoom - 1,
      );
    }
  }, [bitmap, zoom, viewport, width, height, editor.cursor, tool, primary, brushSize, panning, redrawCount, onionSkin, onionBefore, onionAfter, sequence, frameId, thumbnails, selection]);

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
    userAdjusted.current = true;
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

      // The selection tool draws a box and never touches pixels, so it commits
      // through the editor's selection path rather than as a command - which is
      // also why it costs no undo step and leaves the document clean.
      if (tool === 'select') {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        marqueeRef.current = { origin: point, current: point };
        redraw();
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
      // The toolbar's clip and dither settings are optional parameters, so they
      // are only sent when they are actually in use.
      const clip = editor.clip === 'none' ? {} : { clip: editor.clip };
      const dither = editor.ditherPattern
        ? { pattern: editor.ditherPattern, level: editor.ditherLevel }
        : {};
      if (activeTool === 'fill') {
        await editor.execute('fill', {
          layer,
          frame,
          x: point.x,
          y: point.y,
          color: hex,
          contiguous: true,
          ...clip,
          ...dither,
        });
      } else if (activeTool === 'replace') {
        const target = editor.hoverColor ?? color;
        await editor.execute('replace_color', {
          layer,
          frame,
          from: rgbaToHex(target),
          to: hex,
          ...clip,
        });
      }
    },
    [editor],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = toPixel(event);
      editor.setCursor(point);
      const marquee = marqueeRef.current;
      if (marquee) {
        marquee.current = point;
        redraw();
        return;
      }
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
      const marquee = marqueeRef.current;
      if (marquee) {
        marqueeRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const box = boxOf(marquee.origin, marquee.current);
        redraw();
        // A click with no drag clears the box, which is the gesture people try first
        // when they want to get back to editing the whole canvas.
        if (box.w === 0 && box.h === 0) {
          if (selection) await editor.clearSelection();
          return;
        }
        // Stamped with the layer and frame that were active, so the agent knows what
        // the box is pointing at rather than guessing from the current selection.
        await editor.selectRegion(box, { layerId: editor.layerId ?? undefined, frameId: editor.frameId ?? undefined });
        return;
      }
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
      // One stroke is one command, so it carries the toolbar's clip and dither
      // settings as a single undo step.
      const clip = editor.clip === 'none' ? {} : { clip: editor.clip };
      const dither = editor.ditherPattern
        ? { pattern: editor.ditherPattern, level: editor.ditherLevel }
        : {};
      await editor.execute('draw_pixels', {
        layer,
        frame,
        pixels: points.map((point) => ({ x: point.x, y: point.y, color })),
        ...clip,
        ...dither,
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
      userAdjusted.current = true;
      panRef.current = {
        x: Math.round(pointerX - before.x * next),
        y: Math.round(pointerY - before.y * next),
      };
      setZoom(next);
    },
    [zoom, setZoom],
  );

  /** Explicit zoom from the pill or the keyboard takes over from the auto-fit. */
  const zoomTo = useCallback(
    (next: number) => {
      userAdjusted.current = true;
      setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)));
    },
    [setZoom],
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
        <button
          type="button"
          className="icon-button"
          onClick={() => zoomTo(zoom - 1)}
          disabled={zoom <= MIN_ZOOM}
          title={t('canvas.zoomOut')}
          aria-label={t('canvas.zoomOut')}
        >
          <Icon name="minus" size={14} />
        </button>
        <span className="zoom-level">{zoom}×</span>
        <button
          type="button"
          className="icon-button"
          onClick={() => zoomTo(zoom + 1)}
          disabled={zoom >= MAX_ZOOM}
          title={t('canvas.zoomIn')}
          aria-label={t('canvas.zoomIn')}
        >
          <Icon name="plus" size={14} />
        </button>
        <span className="status-divider" />
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            userAdjusted.current = false;
            fit(width, height);
          }}
          title={t('canvas.fitHint')}
          aria-label={t('canvas.fitHint')}
        >
          <Icon name="fit" size={14} />
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => zoomTo(1)}
          title={t('canvas.actualHint')}
          aria-label={t('canvas.actualHint')}
        >
          {t('canvas.actual')}
        </button>
      </div>

      {/*
        The selection readout. Sits above the zoom pill in the bottom-right corner,
        and only appears once there is a box - the canvas should look untouched until
        the user has actually selected something.
      */}
      {selection && (
        <div className="selection-actions">
          <span className="selection-size mono">
            {selection.rect.w}×{selection.rect.h}
          </span>
          <span className="selection-origin mono">
            {selection.rect.x}, {selection.rect.y}
          </span>
          <span className="status-divider" />
          <button
            type="button"
            className={`pill${selection.mode === 'enforce' ? ' is-accent' : ''}`}
            onClick={() =>
              void editor.setSelectionMode(selection.mode === 'enforce' ? 'hint' : 'enforce')
            }
            title={
              selection.mode === 'enforce'
                ? t('selection.enforceHint')
                : t('selection.hintHint')
            }
            aria-pressed={selection.mode === 'enforce'}
          >
            {selection.mode === 'enforce' ? t('selection.enforce') : t('selection.hint')}
          </button>
          <button
            type="button"
            className="icon-button is-danger"
            onClick={() => void editor.clearSelection()}
            title={t('selection.clearHint')}
            aria-label={t('selection.clear')}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The transparency checkerboard is a 16px tile built once and cached. The
 * colours are theme values, so the cache is dropped when the theme changes
 * rather than keeping a pattern the light theme can never use.
 */
function checkerPattern(
  context: CanvasRenderingContext2D,
  light: string,
  dark: string,
): CanvasPattern | string {
  if (!checkerCache) {
    const tile = document.createElement('canvas');
    tile.width = 16;
    tile.height = 16;
    const tileContext = tile.getContext('2d');
    if (!tileContext) return light;
    tileContext.fillStyle = light;
    tileContext.fillRect(0, 0, 16, 16);
    tileContext.fillStyle = dark;
    tileContext.fillRect(0, 0, 8, 8);
    tileContext.fillRect(8, 8, 8, 8);
    checkerCache = tile;
  }
  return context.createPattern(checkerCache, 'repeat') ?? light;
}

let checkerCache: HTMLCanvasElement | null = null;
