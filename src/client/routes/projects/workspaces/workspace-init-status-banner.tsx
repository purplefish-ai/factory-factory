import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { memo } from 'react';
import { getStatusBannerClassName } from '@/client/lib/status-banner-styles';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import type { WorkspaceRetryAvailability } from '@/shared/workspace-init-retry';

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
      <div
        className={[
          'rounded-md border p-3 text-sm flex items-start gap-3',
          getStatusBannerClassName(banner.kind),
        ].join(' ')}
      >
        {banner.kind === 'info' ? (
          <SpinnerGapIcon className="h-4 w-4 mt-0.5 shrink-0 animate-spin" />
        ) : (
          <WarningIcon className="h-4 w-4 mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
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
                  disabled={retryPending || retryAvailability?.status !== 'AVAILABLE'}
                  onClick={onRetry}
                >
                  {retryPending ? (
                    <Spinner className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                  ) : (
                    <ArrowsClockwiseIcon className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {retryPending ? 'Retrying…' : 'Retry setup'}
                </Button>
              )}
              {banner.showPlay && (
                <Button size="sm" onClick={onPlay}>
                  <PlayIcon className="h-3.5 w-3.5 mr-1.5" />
                  Dispatch queued messages
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
