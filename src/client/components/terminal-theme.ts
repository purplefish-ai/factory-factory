import type { ITheme } from '@xterm/xterm';
import { mixOver, parseThemeColor, rgbToHex, type Rgb } from '@/client/lib/color-contrast';

/** xterm accepts sRGB colors, while presets and custom overrides can use OKLCH. */
function readColor(style: CSSStyleDeclaration, token: string, fallback: Rgb): Rgb {
  const value = style.getPropertyValue(`--${token}`).trim();
  if (!value) {
    return fallback;
  }
  const parsed = parseThemeColor(value);
  if (parsed) {
    return parsed.rgb;
  }
  // Let the browser resolve other supported color syntax, such as color-mix.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return fallback;
  }
  context.fillStyle = rgbToHex(fallback);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return [red / 255, green / 255, blue / 255];
}

/** Resolve the active preset and user overrides to a terminal's ANSI palette. */
export function readTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const foreground = readColor(style, 'foreground', [0, 0, 0]);
  const background = readColor(style, 'background', [1, 1, 1]);
  const muted = readColor(style, 'muted-foreground', foreground);
  const red = readColor(style, 'destructive', foreground);
  const green = readColor(style, 'success', foreground);
  const yellow = readColor(style, 'warning', foreground);
  const blue = readColor(style, 'info', foreground);
  const magenta = readColor(style, 'merged', foreground);
  const cyan = mixOver(blue, green, 0.5);
  const bright = (color: Rgb) => rgbToHex(mixOver(foreground, color, 0.2));
  return {
    background: rgbToHex(background),
    foreground: rgbToHex(foreground),
    cursor: rgbToHex(foreground),
    cursorAccent: rgbToHex(background),
    selectionBackground: rgbToHex(mixOver(foreground, background, 0.2)),
    selectionForeground: rgbToHex(foreground),
    // Neutral ANSI slots follow the theme's readable text colors in both modes.
    black: rgbToHex(foreground),
    brightBlack: rgbToHex(muted),
    white: rgbToHex(muted),
    brightWhite: rgbToHex(foreground),
    red: rgbToHex(red),
    green: rgbToHex(green),
    yellow: rgbToHex(yellow),
    blue: rgbToHex(blue),
    magenta: rgbToHex(magenta),
    cyan: rgbToHex(cyan),
    brightRed: bright(red),
    brightGreen: bright(green),
    brightYellow: bright(yellow),
    brightBlue: bright(blue),
    brightMagenta: bright(magenta),
    brightCyan: bright(cyan),
  };
}
