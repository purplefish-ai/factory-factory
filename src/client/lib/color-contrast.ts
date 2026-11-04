/**
 * WCAG contrast helpers for the theme palette.
 *
 * Used by the palette contrast test (which parses the theme CSS) and the
 * Foundations Storybook stories (which read rendered colors). Only the color
 * syntaxes used by `globals.css` and `theme-presets.css` are supported:
 * `#rrggbb`, `#rgb` and `oklch(L C H)` / `oklch(L C H / alpha)`.
 */

/** sRGB channels in the 0–1 range. */
export type Rgb = readonly [number, number, number];

export interface ParsedColor {
  rgb: Rgb;
  alpha: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function encodeSrgb(linear: number): number {
  const value = clamp01(linear);
  return value <= 0.003_130_8 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function decodeSrgb(channel: number): number {
  return channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Converts OKLCH to gamut-clipped sRGB, matching how browsers clip today. */
export function oklchToRgb(lightness: number, chroma: number, hueDegrees: number): Rgb {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  return [
    encodeSrgb(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s),
    encodeSrgb(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s),
    encodeSrgb(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s),
  ];
}

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const OKLCH_PATTERN =
  /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/i;

/** Parses a theme color literal, or returns null for unsupported syntax. */
export function parseThemeColor(value: string): ParsedColor | null {
  const text = value.trim();
  const hex = HEX_PATTERN.exec(text);
  if (hex?.[1]) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : hex[1];
    const channel = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return { rgb: [channel(0), channel(2), channel(4)], alpha: 1 };
  }
  const oklch = OKLCH_PATTERN.exec(text);
  if (oklch) {
    const lightness = Number(oklch[1]) / (oklch[2] ? 100 : 1);
    const alpha = oklch[5] === undefined ? 1 : Number(oklch[5]) / (oklch[6] ? 100 : 1);
    return { rgb: oklchToRgb(lightness, Number(oklch[3]), Number(oklch[4])), alpha };
  }
  return null;
}

/** Composites `foreground` at `alpha` over an opaque `background`. */
export function mixOver(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  const blend = (front: number, back: number) => front * alpha + back * (1 - alpha);
  return [
    blend(foreground[0], background[0]),
    blend(foreground[1], background[1]),
    blend(foreground[2], background[2]),
  ];
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * decodeSrgb(rgb[0]) + 0.7152 * decodeSrgb(rgb[1]) + 0.0722 * decodeSrgb(rgb[2]);
}

/** WCAG 2.x contrast ratio between two opaque colors (1–21). */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) =>
      Math.round(clamp01(channel) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}
