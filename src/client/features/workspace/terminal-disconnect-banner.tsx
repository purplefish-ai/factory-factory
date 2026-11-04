interface TerminalDisconnectBannerProps {
  /** The transport stopped retrying; offer a manual reconnect. */
  gaveUp: boolean;
  onReconnect: () => void;
}

/**
 * Shown above the terminal while its transport is disconnected, because input
 * typed during the gap is dropped. The terminal is always dark, so the `dark`
 * class scopes the selected scheme's dark tokens (theme-presets.css matches
 * `.dark` descendants) and the banner paints its own dark background. The
 * palette test covers warning on its tint over each dark background. This lives outside
 * terminal-panel.tsx so it stays under the raw-palette lint rule, which exempts
 * that file only for its fixed zinc terminal surface.
 */
export function TerminalDisconnectBanner({ gaveUp, onReconnect }: TerminalDisconnectBannerProps) {
  return (
    <div className="dark border-b border-warning/30 bg-background">
      <div className="flex items-center justify-between gap-2 bg-warning/10 px-3 py-1.5">
        {/* <output> is a polite status region, so the gap is announced. */}
        <output className="text-xs text-warning">
          {gaveUp
            ? 'Terminal disconnected. Input will not be delivered until you reconnect.'
            : 'Terminal disconnected — reconnecting… Input typed now will not be delivered.'}
        </output>
        {gaveUp && (
          <button
            type="button"
            onClick={onReconnect}
            className="shrink-0 rounded border border-warning/40 px-2 py-0.5 text-xs text-warning hover:bg-warning/10"
          >
            Reconnect
          </button>
        )}
      </div>
    </div>
  );
}
