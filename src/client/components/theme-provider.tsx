import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { useEffect } from 'react';
import { parseThemeColor, rgbToHex } from '@/client/lib/color-contrast';

interface ThemeProviderProps {
  children: React.ReactNode;
}

const backdropSelector =
  '[data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [data-slot="sheet-overlay"]';

function containsBackdrop(node: Node) {
  return (
    node instanceof Element &&
    (node.matches(backdropSelector) || node.querySelector(backdropSelector) !== null)
  );
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  useEffect(() => {
    // Let CSS resolve all supported theme colors (including oklch and overrides).
    const colorProbe = document.createElement('span');
    colorProbe.hidden = true;
    document.body.append(colorProbe);
    const updateThemeColor = () => {
      const background = getComputedStyle(document.body).backgroundColor;
      const nativeBackground = parseThemeColor(
        getComputedStyle(document.documentElement).getPropertyValue('--background')
      );
      if (nativeBackground) {
        void window.electronAPI
          ?.setBackgroundColor?.(rgbToHex(nativeBackground.rgb))
          .catch(() => undefined);
      }
      const backdropCount = document.querySelectorAll(backdropSelector).length;
      let color = background;
      if (backdropCount > 0) {
        // Shared dialog and sheet primitives use bg-black/50. Native PWA corners
        // cannot be covered by DOM backdrops; tint them with the same composite.
        colorProbe.style.backgroundColor = `color-mix(in srgb, ${background} ${100 * 0.5 ** backdropCount}%, black)`;
        color = getComputedStyle(colorProbe).backgroundColor;
      }
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
    };
    // Appearance presets/overrides and next-themes all update <html>. Observe
    // those changes so the browser chrome follows cached and live preferences.
    const observer = new MutationObserver(updateThemeColor);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-color-scheme'],
    });
    const backdropObserver = new MutationObserver((records) => {
      // Ignore transcript streaming and other unrelated DOM updates. Keep
      // closing backdrops counted until Radix removes them after animation.
      if (
        records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some(containsBackdrop)
        )
      ) {
        updateThemeColor();
      }
    });
    backdropObserver.observe(document.body, { childList: true, subtree: true });
    updateThemeColor();
    return () => {
      observer.disconnect();
      backdropObserver.disconnect();
      colorProbe.remove();
    };
  }, []);

  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
