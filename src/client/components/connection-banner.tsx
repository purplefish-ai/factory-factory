import { StatusCallout } from '@/client/components/status-callout';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useConnectionHealth } from '@/hooks/websocket-connection-health';

/** The package version this bundle was built from (`vite.config.ts`); unset in tests and Storybook. */
const BUNDLE_VERSION = import.meta.env.FF_APP_VERSION;

export type ConnectionBannerState = 'reconnecting' | 'outdated' | null;

interface ConnectionBannerContentProps {
  state: ConnectionBannerState;
  onReload: () => void;
}

/**
 * One app-wide strip for the connection every page depends on: "Reconnecting…"
 * while the snapshot or chat socket is retrying, and "Reload to update" when
 * the server runs a different version from this tab. The reload waits for the
 * user, who may be typing.
 */
export function ConnectionBannerContent({ state, onReload }: ConnectionBannerContentProps) {
  if (state === 'reconnecting') {
    return (
      <StatusCallout
        tone="warning"
        variant="strip"
        size="sm"
        role="status"
        data-testid="connection-banner-reconnecting"
        icon={<Spinner aria-hidden="true" className="size-3.5" />}
      >
        Connection lost. Reconnecting…
      </StatusCallout>
    );
  }
  if (state === 'outdated') {
    return (
      <StatusCallout
        tone="info"
        variant="strip"
        size="sm"
        role="status"
        data-testid="connection-banner-outdated"
        action={
          <Button type="button" variant="outline" size="xs" onClick={onReload}>
            Reload to update
          </Button>
        }
      >
        Factory Factory has been updated.
      </StatusCallout>
    );
  }
  return null;
}

function reloadPage() {
  window.location.reload();
}

interface ConnectionBannerProps {
  /** The version this tab was built from; defaults to the bundle's. */
  clientVersion?: string;
  onReload?: () => void;
}

export function ConnectionBanner({
  clientVersion = BUNDLE_VERSION,
  onReload = reloadPage,
}: ConnectionBannerProps) {
  const { reconnecting, serverVersion } = useConnectionHealth();
  // An older server sends no version, and a test or Storybook bundle has none.
  const outdated = Boolean(clientVersion && serverVersion && serverVersion !== clientVersion);
  let state: ConnectionBannerState = null;
  if (reconnecting) {
    state = 'reconnecting';
  } else if (outdated) {
    state = 'outdated';
  }
  return <ConnectionBannerContent state={state} onReload={onReload} />;
}
