// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTerminalTheme } from './terminal-theme';

const tokens = {
  '--background': '#ffffff',
  '--foreground': '#111111',
  '--muted-foreground': '#555555',
  '--destructive': '#aa0000',
  '--success': '#008800',
  '--warning': '#885500',
  '--info': '#0000aa',
  '--merged': '#880088',
};

afterEach(() => {
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('readTerminalTheme', () => {
  it('keeps ANSI semantic hues and derives cursor, neutral slots and selection from the preset', () => {
    for (const [token, color] of Object.entries(tokens)) {
      document.documentElement.style.setProperty(token, color);
    }
    expect(readTerminalTheme()).toMatchObject({
      background: '#ffffff',
      foreground: '#111111',
      cursor: '#111111',
      cursorAccent: '#ffffff',
      selectionForeground: '#111111',
      selectionBackground: '#cfcfcf',
      black: '#111111',
      white: '#555555',
      brightBlack: '#555555',
      brightWhite: '#111111',
      red: '#aa0000',
      green: '#008800',
      yellow: '#885500',
      blue: '#0000aa',
      magenta: '#880088',
      cyan: '#004455',
      brightRed: '#8b0303',
    });
  });

  it('converts OKLCH tokens to colors xterm can parse', () => {
    document.documentElement.style.setProperty('--background', 'oklch(1 0 0)');
    document.documentElement.style.setProperty('--foreground', 'oklch(0 0 0)');
    expect(readTerminalTheme()).toMatchObject({ background: '#ffffff', foreground: '#000000' });
  });

  it('uses browser rasterization for custom color-mix overrides', () => {
    document.documentElement.style.setProperty('--foreground', 'color-mix(in srgb, red, blue)');
    const context = {
      fillStyle: '',
      fillRect: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([128, 0, 128, 255]) }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    );
    expect(readTerminalTheme().foreground).toBe('#800080');
  });
});
