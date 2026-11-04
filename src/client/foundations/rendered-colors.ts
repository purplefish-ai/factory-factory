/**
 * Reads theme tokens as rendered by the browser so Foundations stories can
 * show live contrast numbers for the selected theme and color scheme.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import type { Rgb } from '@/client/lib/color-contrast';

let canvasContext: CanvasRenderingContext2D | null | undefined;

/** Converts any CSS color the browser understands (including oklch) to sRGB. */
function cssColorToRgb(color: string): Rgb | null {
  if (canvasContext === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvasContext = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!canvasContext) {
    return null;
  }
  canvasContext.clearRect(0, 0, 1, 1);
  canvasContext.fillStyle = '#000000';
  canvasContext.fillStyle = color;
  canvasContext.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = canvasContext.getImageData(0, 0, 1, 1).data;
  return [red / 255, green / 255, blue / 255];
}

export interface RenderedToken {
  /** The custom property value as written in the theme CSS. */
  value: string;
  rgb: Rgb | null;
}

/**
 * Resolves `--token` custom properties inside `container`, which inherits the
 * same theme classes as the rest of the story.
 */
export function useRenderedTokens(tokens: readonly string[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [resolved, setResolved] = useState<ReadonlyMap<string, RenderedToken>>(new Map());
  const tokenKey = tokens.join(',');

  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) {
      return;
    }
    const probe = document.createElement('span');
    container.appendChild(probe);
    const next = new Map<string, RenderedToken>();
    for (const token of tokenKey.split(',')) {
      probe.style.backgroundColor = `var(--${token})`;
      const value = getComputedStyle(probe).getPropertyValue(`--${token}`).trim();
      // An undefined token computes to transparent, which would read as black.
      next.set(token, {
        value,
        rgb: value ? cssColorToRgb(getComputedStyle(probe).backgroundColor) : null,
      });
    }
    probe.remove();
    setResolved(next);
  }, [tokenKey]);

  return { ref, resolved };
}
