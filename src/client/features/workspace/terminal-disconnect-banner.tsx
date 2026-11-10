import { StatusCallout } from '@/client/components/status-callout';
import { Button } from '@/components/ui/button';

interface TerminalDisconnectBannerProps {
  /** The transport stopped retrying; offer a manual reconnect. */
  gaveUp: boolean;
  onReconnect: () => void;
}

/** Announces dropped input during a disconnect using the active theme's warning colors. */
export function TerminalDisconnectBanner({ gaveUp, onReconnect }: TerminalDisconnectBannerProps) {
  return (
    // The opaque backing keeps the translucent tint independent of the terminal behind it.
    <div className="bg-background">
      <StatusCallout
        tone="warning"
        variant="strip"
        size="sm"
        action={
          gaveUp && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onReconnect}
              className="shrink-0 border border-warning/40 font-normal text-warning hover:bg-warning/10 hover:text-warning dark:hover:bg-warning/10"
            >
              Reconnect
            </Button>
          )
        }
      >
        {/* <output> is a polite status region, so the gap is announced. */}
        <output>
          {gaveUp
            ? 'Terminal disconnected. Input will not be delivered until you reconnect.'
            : 'Terminal disconnected — reconnecting… Input typed now will not be delivered.'}
        </output>
      </StatusCallout>
    </div>
  );
}
