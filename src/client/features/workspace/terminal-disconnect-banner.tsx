interface TerminalDisconnectBannerProps {
  /** The transport stopped retrying; offer a manual reconnect. */
  gaveUp: boolean;
  onReconnect: () => void;
}

/** Announces dropped input during a disconnect using the active theme's warning colors. */
export function TerminalDisconnectBanner({ gaveUp, onReconnect }: TerminalDisconnectBannerProps) {
  return (
    <div className="border-b border-warning/30 bg-background">
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
