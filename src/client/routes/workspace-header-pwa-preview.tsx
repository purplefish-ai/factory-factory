import { type CSSProperties, type ReactNode, useEffect } from 'react';
import headerCss from '@/client/components/app-header.css?raw';

// Storybook has no native window. Substitute only browser-owned geometry and
// the media query, so the preview exercises the production CSS and controls.
const previewCss = headerCss
  .replace('(display-mode: window-controls-overlay)', 'all')
  .replace(/env\((titlebar-area-[\w-]+)(?:,[^)]*)?\)/g, (_match, name: string) => {
    const values: Record<string, string> = {
      'titlebar-area-x': 'var(--preview-titlebar-left)',
      'titlebar-area-y': '0px',
      'titlebar-area-width': 'var(--preview-titlebar-width)',
      'titlebar-area-height': '32px',
    };
    return values[name] ?? _match;
  });

export function WorkspaceHeaderPwaPreview({
  side,
  fontScale = 100,
  children,
}: {
  side: 'left' | 'right';
  fontScale?: number;
  children: ReactNode;
}) {
  useEffect(() => {
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = `${fontScale}%`;
    return () => {
      document.documentElement.style.fontSize = previous;
    };
  }, [fontScale]);

  const left = side === 'left' ? 86 : 0;
  const right = side === 'left' ? 40 : 140;
  return (
    <div
      className="relative"
      style={
        {
          '--preview-titlebar-left': `${left}px`,
          '--preview-titlebar-width': `calc(100% - ${left + right}px)`,
        } as CSSProperties
      }
    >
      <style>{previewCss}</style>
      {children}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 flex items-center text-muted-foreground"
        style={{
          height: 32,
          gap: 8,
          paddingInline: 12,
          ...(side === 'left' ? { left: 0 } : { right: 0 }),
        }}
      >
        {side === 'left' ? (
          <>
            <span className="rounded-full bg-red-400" style={{ width: 12, height: 12 }} />
            <span className="rounded-full bg-yellow-400" style={{ width: 12, height: 12 }} />
            <span className="rounded-full bg-green-500" style={{ width: 12, height: 12 }} />
          </>
        ) : (
          <svg width="112" height="16" viewBox="0 0 112 16" fill="none" stroke="currentColor">
            <path d="M8 11h12 M46 3h10v10H46z M86 3l10 10m0-10L86 13" />
          </svg>
        )}
      </div>
    </div>
  );
}
