import type { ReactNode } from 'react';

export type IconName =
  | 'plus'
  | 'folder'
  | 'save'
  | 'more'
  | 'export'
  | 'chevronDown'
  | 'undo'
  | 'redo'
  | 'globe'
  | 'pencil'
  | 'eraser'
  | 'line'
  | 'rectangle'
  | 'ellipse'
  | 'fill'
  | 'replace'
  | 'eyedropper'
  | 'pan'
  | 'swap'
  | 'copy'
  | 'arrowUp'
  | 'arrowDown'
  | 'merge'
  | 'trash'
  | 'eye'
  | 'eyeOff'
  | 'lock'
  | 'play'
  | 'pause'
  | 'arrowLeft'
  | 'arrowRight'
  | 'tag'
  | 'magic'
  | 'grid'
  | 'map'
  | 'image'
  | 'close'
  | 'fit';

const paths: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  folder: <path d="M3.5 6.5h6l2-2h9v14h-17z" />,
  save: (
    <>
      <path d="M5 3.5h11l3 3V20.5H5z" />
      <path d="M8 3.5v6h8v-6M8.5 20.5v-7h7v7" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  export: (
    <>
      <path d="M12 3v12" />
      <path d="m7.5 7.5 4.5-4.5 4.5 4.5" />
      <path d="M5 13v7h14v-7" />
    </>
  ),
  chevronDown: <path d="m7 9.5 5 5 5-5" />,
  undo: (
    <>
      <path d="M9 7 4.5 11 9 15" />
      <path d="M5 11h8.5a5.5 5.5 0 0 1 5.5 5.5" />
    </>
  ),
  redo: (
    <>
      <path d="m15 7 4.5 4-4.5 4" />
      <path d="M19 11h-8.5A5.5 5.5 0 0 0 5 16.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z" />
    </>
  ),
  pencil: (
    <>
      <path d="m4 20 4.2-1 10.9-11-3.2-3.1L5 15.8z" />
      <path d="m13.8 6.1 3.2 3.1M4 20l1-4.2" />
    </>
  ),
  eraser: (
    <>
      <path d="m4.5 15.5 8.7-9.2a2 2 0 0 1 2.9 0l2.1 2a2 2 0 0 1 0 2.9l-7.2 7.6H7.2z" />
      <path d="m9 11 5.2 5M11.1 18.8H20" />
    </>
  ),
  line: <path d="m5 19 14-14" />,
  rectangle: <rect x="4" y="5.5" width="16" height="13" rx="1" />,
  ellipse: <ellipse cx="12" cy="12" rx="8" ry="6.5" />,
  fill: (
    <>
      <path d="m5 11 6.5-6.5 8 8L13 19z" />
      <path d="M8.5 7.5 15 14M12 4l8 8" />
      <path d="M19.5 16.5s-1.7 2-1.7 3.2a1.7 1.7 0 0 0 3.4 0c0-1.2-1.7-3.2-1.7-3.2Z" fill="currentColor" stroke="none" />
    </>
  ),
  replace: (
    <>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
      <path d="m14 5 3 3-3 3M10 13l-3 3 3 3" />
    </>
  ),
  eyedropper: (
    <>
      <path d="m14 5 5 5M15.5 3.5l5 5-3 3-5-5z" />
      <path d="m13.5 8.5-7 7-2 5 5-2 7-7" />
    </>
  ),
  pan: (
    <>
      <path d="M8.5 11V7.5a1.5 1.5 0 0 1 3 0V10" />
      <path d="M11.5 10V6.5a1.5 1.5 0 0 1 3 0V10" />
      <path d="M14.5 10V8a1.5 1.5 0 0 1 3 0v5" />
      <path d="M8.5 10V9a1.5 1.5 0 0 0-3 0v4.5c0 4 2.7 6.5 6.5 6.5h1c3.3 0 5.5-2 5.5-5.5V11" />
    </>
  ),
  swap: (
    <>
      <path d="M7 7h11l-3-3M17 17H6l3 3" />
      <path d="m15 4 3 3-3 3M9 14l-3 3 3 3" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="11" rx="1.5" />
      <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
    </>
  ),
  arrowUp: (
    <>
      <path d="M12 20V4" />
      <path d="m6.5 9.5 5.5-5.5 5.5 5.5" />
    </>
  ),
  arrowDown: (
    <>
      <path d="M12 4v16" />
      <path d="m6.5 14.5 5.5 5.5 5.5-5.5" />
    </>
  ),
  merge: (
    <>
      <path d="M12 4v6M6.5 14.5 12 10l5.5 4.5" />
      <path d="M6.5 14.5V20h11v-5.5" />
    </>
  ),
  trash: (
    <>
      <path d="M5 7h14M9 7V4.5h6V7M7 7l1 13h8l1-13" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12s3.2-5.5 9.2-5.5 9.2 5.5 9.2 5.5-3.2 5.5-9.2 5.5S2.8 12 2.8 12Z" />
      <circle cx="12" cy="12" r="2.3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4 20 20M9.5 6.8A9.7 9.7 0 0 1 12 6.5c6 0 9.2 5.5 9.2 5.5a16 16 0 0 1-2.4 3M14.2 14.3A2.5 2.5 0 0 1 9.7 9.8" />
      <path d="M6.1 8.2A15.7 15.7 0 0 0 2.8 12S6 17.5 12 17.5c1.1 0 2.1-.2 3-.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5.5" y="10" width="13" height="10" rx="2" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
    </>
  ),
  play: <path d="m8 5 11 7-11 7z" fill="currentColor" />,
  pause: (
    <>
      <path d="M8 5v14M16 5v14" strokeWidth="3" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M20 12H4" />
      <path d="m9.5 6.5-5.5 5.5 5.5 5.5" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M4 12h16" />
      <path d="m14.5 6.5 5.5 5.5-5.5 5.5" />
    </>
  ),
  tag: (
    <>
      <path d="M4 5v6l9 9 7-7-9-9z" />
      <circle cx="8.5" cy="8.5" r="1.3" />
    </>
  ),
  magic: (
    <>
      <path d="m5 19 9.5-9.5M13 5l.7 2.3L16 8l-2.3.7L13 11l-.7-2.3L10 8l2.3-.7z" />
      <path d="m18.5 13 .5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </>
  ),
  map: (
    <>
      <path d="m4 6 5-2 6 2 5-2v14l-5 2-6-2-5 2z" />
      <path d="M9 4v14M15 6v14" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="9" r="1.5" />
      <path d="m5.5 17 4.5-4.5 3 3 2-2 4 3.5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  fit: (
    <>
      <path d="M8 4H4v4M16 4h4v4M20 16v4h-4M4 16v4h4" />
      <path d="M9 9h6v6H9z" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
  label,
}: {
  name: IconName;
  size?: number;
  className?: string;
  label?: string;
}): React.ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
    >
      {label && <title>{label}</title>}
      {paths[name]}
    </svg>
  );
}

export function PixelMark({ size = 32 }: { size?: number }): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="pixel-mark">
      <rect x="2" y="2" width="28" height="28" rx="8" fill="currentColor" opacity="0.12" />
      <rect x="7" y="7" width="8" height="8" rx="1.5" fill="#6868e8" />
      <rect x="17" y="7" width="8" height="8" rx="1.5" fill="#f0a44c" />
      <rect x="7" y="17" width="8" height="8" rx="1.5" fill="#4dbb8b" />
      <rect x="17" y="17" width="8" height="8" rx="1.5" fill="#ec6f86" />
    </svg>
  );
}
