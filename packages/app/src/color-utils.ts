import { parseColor, type Color } from '@pixel/core';

/** `#rrggbbaa`, the form the command layer accepts and the UI shows. */
export function rgbaToHex(color: Color): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}${part(color.a)}`;
}

export function rgbaToCss(color: Color, alpha = color.a / 255): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

/** Liberal parsing: accepts `#rgb`, `#rrggbb`, names, and anything else core knows. */
export function toColor(input: string, fallback: Color = { r: 0, g: 0, b: 0, a: 255 }): Color {
  try {
    return parseColor(input);
  } catch {
    return fallback;
  }
}

export function colorsEqual(a: Color, b: Color): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}
