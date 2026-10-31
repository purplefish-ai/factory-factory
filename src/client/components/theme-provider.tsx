import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { useEffect } from 'react';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  useEffect(() => {
    const updateThemeColor = () => {
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', getComputedStyle(document.body).backgroundColor);
    };
    // Appearance presets/overrides and next-themes all update <html>. Observe
    // those changes so the browser chrome follows cached and live preferences.
    const observer = new MutationObserver(updateThemeColor);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-color-scheme'],
    });
    updateThemeColor();
    return () => observer.disconnect();
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
