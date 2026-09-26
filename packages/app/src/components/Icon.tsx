/**
 * Every icon in the app, drawn by hand.
 *
 * Each glyph is a set of raw SVG primitives on a 24x24 grid: `p` is a stroked
 * path (1.7px, round caps and joins), `F` is a filled path, `e` and `E` are
 * stroked and filled ellipses. There is no icon library, no icon font and no
 * runtime dependency — this table *is* the icon set, and the same geometry
 * drives the design file.
 *
 * Kept as one entry per glyph so a new icon is a single line, and so the whole
 * set can be diffed by eye.
 */
import type { ReactNode } from 'react';

export type IconName =
  // window
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  // chrome
  | 'plus'
  | 'minus'
  | 'folder'
  | 'save'
  | 'dots'
  | 'globe'
  | 'sun'
  | 'moon'
  | 'check'
  | 'cross'
  | 'sidebar'
  // files
  | 'export'
  | 'image'
  | 'grid'
  | 'map'
  // history
  | 'undo'
  | 'redo'
  | 'clock'
  // tools
  | 'pencil'
  | 'eraser'
  | 'line'
  | 'rectangle'
  | 'ellipse'
  | 'fill'
  | 'replace'
  | 'eyedropper'
  | 'selection'
  | 'hand'
  | 'swap'
  | 'dither'
  | 'clip'
  | 'move4'
  // layers
  | 'stack'
  | 'paint'
  | 'copy'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'
  | 'mergeDown'
  | 'trash'
  | 'eye'
  | 'eyeOff'
  | 'lock'
  // timeline
  | 'play'
  | 'pause'
  | 'skipStart'
  | 'skipEnd'
  | 'tag'
  | 'onion'
  | 'sparkle'
  // canvas
  | 'fit'
  | 'chevronDown'
  | 'chevronRight'
  | 'sliders'
  | 'settings'
  | 'contrast'
  | 'display'
  | 'keyboard'
  | 'info';

type Primitive =
  | { k: 'p'; d: string; w?: number }
  | { k: 'F'; d: string }
  | { k: 'e'; x: number; y: number; w: number; h: number }
  | { k: 'E'; x: number; y: number; w: number; h: number };

const ICONS: Record<IconName, Primitive[]> = {
  // ---- window ---------------------------------------------------------------
  minimize: [{ k: 'p', d: 'M5.5 12h13' }],
  maximize: [{ k: 'p', d: 'M6 6.5h11.5v11H6z' }],
  restore: [{ k: 'p', d: 'M6 8.5h9.5V18H6zM8.5 6h9.5v9.5' }],
  close: [{ k: 'p', d: 'M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4' }],

  // ---- chrome ---------------------------------------------------------------
  plus: [{ k: 'p', d: 'M12 5.5v13M5.5 12h13' }],
  minus: [{ k: 'p', d: 'M5.5 12h13' }],
  folder: [
    {
      k: 'p',
      d: 'M3.5 7.2A1.6 1.6 0 0 1 5.1 5.6h4.1l2-2.4h6.2a1.6 1.6 0 0 1 1.6 1.6v12.6a1.6 1.6 0 0 1-1.6 1.6H5.1a1.6 1.6 0 0 1-1.6-1.6z',
    },
  ],
  save: [{ k: 'p', d: 'M5 4.5h10.8l3.2 3.2v11.8H5zM8.2 4.5v5.8h7.6V4.5M8.5 19.5v-6h7v6' }],
  dots: [
    { k: 'E', x: 2.4, y: 9.7, w: 5.6, h: 4.6 },
    { k: 'E', x: 9.2, y: 9.7, w: 5.6, h: 4.6 },
    { k: 'E', x: 16, y: 9.7, w: 5.6, h: 4.6 },
  ],
  globe: [
    { k: 'e', x: 3.2, y: 3.2, w: 17.6, h: 17.6 },
    { k: 'p', d: 'M3.2 12h17.6M12 3.2c2.4 2.6 3.7 5.6 3.7 8.8S14.4 18.2 12 20.8c-2.4-2.6-3.7-5.6-3.7-8.8S9.6 5.8 12 3.2z' },
  ],
  check: [{ k: 'p', d: 'M5 12.5l4.5 4.5L19 7.5' }],
  // Same gesture as the window close button, sized for an inline row action.
  cross: [{ k: 'p', d: 'M7.6 7.6l8.8 8.8M16.4 7.6l-8.8 8.8' }],
  // Appearance: disc plus eight rays, and a single crescent arc.
  sun: [
    {
      k: 'p',
      d: 'M12 7.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8zM12 2.4v2.4M12 19.2v2.4M2.4 12h2.4M19.2 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7',
    },
  ],
  moon: [{ k: 'p', d: 'M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8 8.6 8.6 0 1 0 20.2 14.6z' }],
  sidebar: [{ k: 'p', d: 'M3.8 4.6h16.4v14.8H3.8zM15 4.6v14.8' }],

  // ---- files ----------------------------------------------------------------
  export: [{ k: 'p', d: 'M12 4v10.4M7.9 10.2L12 14.3l4.1-4.1M4.6 19.4h14.8' }],
  image: [
    { k: 'p', d: 'M3.6 4.8h16.8v14.4H3.6zM3.6 16.4l4.8-4.8 3.1 3.1 2.2-2.2 3.9 3.9M9 9.6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z' },
  ],
  grid: [{ k: 'p', d: 'M4 4h6.4v6.4H4zM13.6 4H20v6.4h-6.4zM4 13.6h6.4V20H4zM13.6 13.6H20V20h-6.4z' }],
  map: [{ k: 'p', d: 'M3.6 5.8l5.2-2.2 6.4 2.2 5.2-2.2v14.6l-5.2 2.2-6.4-2.2-5.2 2.2zM8.8 3.6v14.6M15.2 5.8v14.6' }],

  // ---- history --------------------------------------------------------------
  undo: [{ k: 'p', d: 'M8.8 7.6L4.4 12l4.4 4.4M4.4 12h9.8a5.4 5.4 0 0 1 0 10.8h-3.4' }],
  redo: [{ k: 'p', d: 'M15.2 7.6L19.6 12l-4.4 4.4M19.6 12H9.8a5.4 5.4 0 0 0 0 10.8h3.4' }],
  clock: [{ k: 'p', d: 'M12 4.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6zM12 7.8V12l3.2 2.2' }],

  // ---- tools ----------------------------------------------------------------
  pencil: [{ k: 'p', d: 'M4.2 19.8l4.3-1L19 8.3l-3.3-3.2L5.2 15.5zM13.6 6.1l3.3 3.2' }],
  eraser: [
    { k: 'p', d: 'M4.6 15.4l8.6-9a2 2 0 0 1 2.8 0l2.1 2a2 2 0 0 1 0 2.9l-7.1 7.5H7.3zM9.1 11.1l5.1 5M11.2 18.8H20' },
  ],
  line: [{ k: 'p', d: 'M5 19l14-14' }],
  rectangle: [{ k: 'p', d: 'M4.2 5.6h15.6v12.8H4.2z' }],
  // A dashed marquee, so it cannot be mistaken for the solid `rect` draw tool.
  selection: [
    { k: 'p', d: 'M4.6 8.2V5.4h2.8M11.8 5.4h2.8v2.8M19.4 11v2.8h-2.8M12.6 18.6H9.8v-2.8' },
    { k: 'p', d: 'M4.6 12.4h14.8' },
  ],
  ellipse: [{ k: 'e', x: 4.2, y: 5.6, w: 15.6, h: 12.8 }],
  fill: [
    { k: 'p', d: 'M5.2 11.1L11.6 4.7l8 8L13.2 19.1zM8.6 7.7L15 14.1M11.6 4.7l8 8' },
    { k: 'F', d: 'M19.6 15.9s-1.7 2-1.7 3.2a1.7 1.7 0 0 0 3.4 0c0-1.2-1.7-3.2-1.7-3.2z' },
  ],
  replace: [{ k: 'p', d: 'M4 8.2h13.4l-3.2-3.2M20 15.8H6.6l3.2 3.2M14.2 5l3.2 3.2-3.2 3.2M9.8 12.6l-3.2 3.2 3.2 3.2' }],
  eyedropper: [
    { k: 'p', d: 'M14.2 5.2l4.6 4.6M15.6 3.6l4.8 4.8-3 3-4.8-4.8zM13.4 8.4l-7.1 7.1-1.9 4.7 4.7-1.9 7.1-7.1' },
  ],
  hand: [
    {
      k: 'p',
      d: 'M8.6 11.2V7.6a1.5 1.5 0 0 1 3 0v2.6M11.6 10.2V6.6a1.5 1.5 0 0 1 3 0v3.6M14.6 10.2V8.2a1.5 1.5 0 0 1 3 0v5c0 3.6-2.6 6.2-6.2 6.2h-.8c-3.6 0-6.4-2.4-6.4-6V9.4a1.5 1.5 0 0 1 3 0v.4',
    },
  ],
  swap: [{ k: 'p', d: 'M6.6 7.2h11.8l-3.2-3.2M17.4 16.8H5.6l3.2 3.2M15.2 4l3.2 3.2-3.2 3.2M8.8 13.6l-3.2 3.2 3.2 3.2' }],
  dither: [
    {
      k: 'p',
      d: 'M4 4h3.4v3.4H4zM10.3 4h3.4v3.4h-3.4zM7.15 7.15h3.4v3.4h-3.4zM4 10.3h3.4v3.4H4zM13.45 10.3h3.4v3.4h-3.4zM7.15 13.45h3.4v3.4h-3.4zM10.3 16.6h3.4V20h-3.4z',
    },
  ],
  clip: [
    { k: 'p', d: 'M3.8 6.2a2 2 0 0 1 2-2h12.4a2 2 0 0 1 2 2v11.6a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2zM12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z' },
  ],
  move4: [
    {
      k: 'p',
      d: 'M12 3.6v16.8M3.6 12h16.8M12 3.6L9.6 6M12 3.6L14.4 6M12 20.4L9.6 18M12 20.4l2.4-2.4M3.6 12L6 9.6M3.6 12L6 14.4M20.4 12L18 9.6M20.4 12L18 14.4',
    },
  ],

  // ---- layers ---------------------------------------------------------------
  stack: [{ k: 'p', d: 'M12 3.6l8.6 4.5-8.6 4.5-8.6-4.5zM3.4 12.4L12 16.9l8.6-4.5M3.4 16.4L12 20.9l8.6-4.5' }],
  paint: [
    {
      k: 'p',
      d: 'M12 3.4c-4.8 0-8.6 3.6-8.6 8 0 2.6 2.2 4.2 4.3 4.2h1.6c1 0 1.7.7 1.7 1.6 0 .4-.1.7-.3 1-.2.3-.4.6-.4 1 0 .8.7 1.4 1.6 1.4 4.5 0 7.7-3.6 7.7-8 0-4.4-3.2-9.2-8-9.2z',
    },
  ],
  copy: [{ k: 'p', d: 'M8.4 8.4h11.2v11.2H8.4zM15.8 8.4V6a1.6 1.6 0 0 0-1.6-1.6H5.6A1.6 1.6 0 0 0 4 6v8.6a1.6 1.6 0 0 0 1.6 1.6h2.8' }],
  arrowUp: [{ k: 'p', d: 'M12 19.6V4.4M6.6 9.8L12 4.4l5.4 5.4' }],
  arrowDown: [{ k: 'p', d: 'M12 4.4v15.2M6.6 14.2L12 19.6l5.4-5.4' }],
  arrowLeft: [{ k: 'p', d: 'M19.6 12H4.4M9.8 6.6L4.4 12l5.4 5.4' }],
  arrowRight: [{ k: 'p', d: 'M4.4 12h15.2M14.2 6.6L19.6 12l-5.4 5.4' }],
  mergeDown: [{ k: 'p', d: 'M12 4.4v6M6.4 14.4L12 10.4l5.6 4M6.4 14.4V20h11.2v-5.6' }],
  trash: [{ k: 'p', d: 'M4.8 6.8h14.4M9 6.8V4.4h6v2.4M6.8 6.8l.9 12.8h8.6l.9-12.8M10 10.4v6M14 10.4v6' }],
  eye: [
    { k: 'p', d: 'M2.6 12S6.3 6.4 12 6.4 21.4 12 21.4 12 17.7 17.6 12 17.6 2.6 12 2.6 12zM14.3 12a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0z' },
  ],
  eyeOff: [
    { k: 'p', d: 'M4 4l16 16M9.6 6.8A9.7 9.7 0 0 1 12 6.5c5.7 0 9.4 5.5 9.4 5.5a17 17 0 0 1-2.5 3.1M14.2 14.2A2.4 2.4 0 0 1 9.6 9.6M6 8.3A15.8 15.8 0 0 0 2.6 12S6.3 17.5 12 17.5c1.1 0 2.1-.2 3-.5' },
  ],
  lock: [{ k: 'p', d: 'M5.6 10.4h12.8v9.2H5.6zM8.6 10.4V7.4a3.4 3.4 0 0 1 6.8 0v3' }],

  // ---- timeline -------------------------------------------------------------
  play: [{ k: 'F', d: 'M8.4 5.2l10.8 6.8-10.8 6.8z' }],
  pause: [{ k: 'p', d: 'M8.6 5.4v13.2M15.4 5.4v13.2', w: 2.6 }],
  skipStart: [
    { k: 'p', d: 'M7 5.4v13.2', w: 2.2 },
    { k: 'F', d: 'M18.6 6.2v11.6L9.4 12z' },
  ],
  skipEnd: [
    { k: 'p', d: 'M17 5.4v13.2', w: 2.2 },
    { k: 'F', d: 'M5.4 6.2v11.6L14.6 12z' },
  ],
  tag: [{ k: 'p', d: 'M4 5.2h6.2l9.2 9.2-6.2 6.2L4 11.4zM8.6 7.4a1.3 1.3 0 1 1-2.6 0 1.3 1.3 0 0 1 2.6 0z' }],
  onion: [{ k: 'p', d: 'M8.6 3.6h11.8v11.8H8.6zM4.2 7.4V20.4h12.8' }],
  sparkle: [
    { k: 'p', d: 'M4.6 19.4L14.4 9.6M13 4.6l.75 2.45L16.2 7.8l-2.45.75L13 11l-.75-2.45L9.8 7.8l2.45-.75zM18.4 12.6l.55 1.75 1.75.55-1.75.55-.55 1.75-.55-1.75-1.75-.55 1.75-.55z' },
  ],

  // ---- canvas ---------------------------------------------------------------
  fit: [{ k: 'p', d: 'M8.4 4H4v4.4M15.6 4H20v4.4M20 15.6V20h-4.4M4 15.6V20h4.4M9.2 9.2h5.6v5.6H9.2z' }],
  chevronDown: [{ k: 'p', d: 'M6.8 9.4L12 14.6l5.2-5.2' }],
  chevronRight: [{ k: 'p', d: 'M9.4 6.8L14.6 12l-5.2 5.2' }],
  sliders: [
    { k: 'p', d: 'M3.6 7.6h8.2M16.6 7.6h3.8M3.6 16.4h3.8M12.2 16.4h8.2' },
    { k: 'e', x: 13.2, y: 5.6, w: 4, h: 4 },
    { k: 'e', x: 8.8, y: 14.4, w: 4, h: 4 },
  ],
  // A ring with eight short teeth: the conventional settings glyph, and the
  // evenodd hole in the middle is what separates it from `sun` at 16px.
  settings: [
    {
      k: 'p',
      d: 'M12 5.9a6.1 6.1 0 1 0 0 12.2 6.1 6.1 0 0 0 0-12.2zM12 8.9a3.1 3.1 0 1 1 0 6.2 3.1 3.1 0 0 1 0-6.2zM12 2.4v2.3M12 19.3v2.3M2.4 12h2.3M19.3 12h2.3M5.1 5.1l1.6 1.6M17.3 17.3l1.6 1.6M18.9 5.1l-1.6 1.6M6.7 17.3l-1.6 1.6',
    },
  ],
  keyboard: [
    {
      k: 'p',
      d: 'M3.2 6.4h17.6v11.2H3.2zM6.4 9.8h0.1M9.6 9.8h0.1M12.8 9.8h0.1M16 9.8h0.1M19.2 9.8h0.1M6.4 12.6h0.1M9.6 12.6h0.1M12.8 12.6h0.1M16 12.6h0.1M19.2 12.6h0.1M8 15.4h8',
    },
  ],
  info: [
    { k: 'p', d: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8zM12 10.8v5.6M12 7.6h0.1' },
  ],
  // Appearance: a disc with one half filled — the conventional contrast mark.
  contrast: [
    { k: 'p', d: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8z' },
    { k: 'F', d: 'M12 4.4a7.6 7.6 0 0 1 0 15.2z' },
  ],
  // "Follow the system": a monitor, not a sun.
  display: [
    { k: 'p', d: 'M3.4 5.2h17.2v10.4H3.4zM8.6 19.4h6.8M12 15.6v3.8' },
  ],
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Supplying a label turns the icon into an `img` with a title. */
  label?: string;
}

export function Icon({ name, size = 16, className, label }: IconProps): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      focusable="false"
    >
      {label && <title>{label}</title>}
      {iconNodes()[name]}
    </svg>
  );
}

/**
 * The node tree is built once from the table rather than on every render: these
 * are static, and a pixel editor re-renders its chrome on every cursor move, so
 * re-creating ~150 elements each time is worth avoiding.
 */
let cache: Record<IconName, ReactNode> | null = null;

function iconNodes(): Record<IconName, ReactNode> {
  return (cache ??= buildNodes());
}

function buildNodes(): Record<IconName, ReactNode> {
  const out = {} as Record<IconName, ReactNode>;
  for (const [name, parts] of Object.entries(ICONS) as [IconName, Primitive[]][]) {
    out[name] = parts.map((part, index) => {
      if (part.k === 'p') {
        return <path key={index} d={part.d} strokeWidth={part.w ?? 1.7} fillRule="evenodd" />;
      }
      if (part.k === 'F') {
        return <path key={index} d={part.d} fill="currentColor" stroke="none" fillRule="evenodd" />;
      }
      if (part.k === 'e') {
        return (
          <ellipse
            key={index}
            cx={part.x + part.w / 2}
            cy={part.y + part.h / 2}
            rx={part.w / 2}
            ry={part.h / 2}
          />
        );
      }
      return (
        <ellipse
          key={index}
          cx={part.x + part.w / 2}
          cy={part.y + part.h / 2}
          rx={part.w / 2}
          ry={part.h / 2}
          fill="currentColor"
          stroke="none"
        />
      );
    });
  }
  return out;
}

/**
 * The four-pixel app mark. Four squares on a rounded tile — legible down to
 * 16px, and unmistakably a pixel-art tool rather than a generic document icon.
 */
export function PixelMark({ size = 20 }: { size?: number }): ReactNode {
  const pad = size * 0.2;
  const dot = (size - pad * 3) / 2;
  const step = dot + pad;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="pixel-mark">
      <rect x={0} y={0} width={size} height={size} rx={size * 0.3} fill="var(--mark-tile)" />
      <rect x={pad} y={pad} width={dot} height={dot} rx={dot * 0.28} fill="var(--accent)" />
      <rect x={pad + step} y={pad} width={dot} height={dot} rx={dot * 0.28} fill="var(--blue)" />
      <rect x={pad} y={pad + step} width={dot} height={dot} rx={dot * 0.28} fill="var(--success)" />
      <rect
        x={pad + step}
        y={pad + step}
        width={dot}
        height={dot}
        rx={dot * 0.28}
        fill="var(--error)"
      />
    </svg>
  );
}

/** Exposed so a test can assert the table and the DOM stay in step. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];
