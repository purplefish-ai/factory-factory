import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { memo } from 'react';
import { StatusCallout } from '@/client/components/status-callout';
import type { StatusTone } from '@/client/lib/status-tones';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import type { WorkspaceRetryAvailability } from '@/shared/workspace-init-retry';

const INIT_BANNER_TONES: Record<WorkspaceInitBanner['kind'], StatusTone> = {
  error: 'danger',
  warning: 'warning',
  info: 'info',
};

export interface InitStatusBannerProps {
  retryAvailability?: WorkspaceRetryAvailability;
  banner: WorkspaceInitBanner;
  retryPending: boolean;
  onRetry: () => void;
  onPlay: () => void;
}

export const InitStatusBanner = memo(function InitStatusBanner({
  banner,
  retryPending,
  retryAvailability,
  onRetry,
  onPlay,
}: InitStatusBannerProps) {
  const hasActions = banner.showRetry || banner.showPlay;

  return (
    <div className="px-4 pt-4">
      <StatusCallout
        tone={INIT_BANNER_TONES[banner.kind]}
        // Setup in progress shows live work; failures keep the warning sign.
        icon={banner.kind === 'info' ? <Spinner aria-hidden="true" /> : WarningIcon}
      >
        <p>{banner.message}</p>
        {banner.showRetry && retryAvailability?.status !== 'AVAILABLE' && (
          <p className="mt-1 text-xs">
            {retryAvailability?.status === 'BLOCKED'
              ? retryAvailability.explanation
              : 'Checking setup retry availability…'}
          </p>
        )}
        {hasActions && (
          <div className="mt-2 flex items-center gap-2">
            {banner.showRetry && (
              <Button
                size="sm"
                variant="outline"
                pending={retryPending}
                pendingLabel="Retrying…"
                disabled={retryAvailability?.status !== 'AVAILABLE'}
                onClick={onRetry}
              >
                <ArrowsClockwiseIcon />
                Retry setup
              </Button>
            )}
            {banner.showPlay && (
              <Button size="sm" onClick={onPlay}>
                <PlayIcon />
                Dispatch queued messages
              </Button>
            )}
          </div>
        )}
      </StatusCallout>
    </div>
  );
});
