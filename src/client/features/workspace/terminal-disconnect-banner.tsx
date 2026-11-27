import { StatusCallout } from '@/client/components/status-callout';

/**
 * Announces dropped input during a disconnect using the active theme's warning
 * colors. The transport keeps reconnecting on its own, so there is no action.
 */
export function TerminalDisconnectBanner() {
  return (
    // The opaque backing keeps the translucent tint independent of the terminal behind it.
    <div className="bg-background">
      <StatusCallout tone="warning" variant="strip" size="sm">
        {/* <output> is a polite status region, so the gap is announced. */}
        <output>
          Terminal disconnected — reconnecting… Input typed now will not be delivered.
        </output>
      </StatusCallout>
    </div>
  );
}
