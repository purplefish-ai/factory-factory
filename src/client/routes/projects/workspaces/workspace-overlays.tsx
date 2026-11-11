import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useState } from 'react';
import { StatusCallout } from '@/client/components/status-callout';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { WorkspaceRetryAvailability } from '@/shared/workspace-init-retry';
import { InitOutputPanel } from './init-output-panel';
import { useRetryWorkspaceInit } from './use-retry-workspace-init';

// =============================================================================
// Script Failed Banner (non-blocking)
// =============================================================================

interface ScriptFailedBannerProps {
  retryAvailability?: WorkspaceRetryAvailability;
  workspaceId: string;
  initErrorMessage: string | null;
  initOutput: string | null;
  hasStartupScript: boolean;
  showPlay?: boolean;
  onPlay?: () => void;
  showDismiss?: boolean;
  onDismiss?: () => void;
}

export function ScriptFailedBanner({
  workspaceId,
  retryAvailability,
  initErrorMessage,
  initOutput,
  hasStartupScript,
  showPlay = false,
  onPlay,
  showDismiss = false,
  onDismiss,
}: ScriptFailedBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const { retry, retryInit } = useRetryWorkspaceInit(workspaceId, retryAvailability);

  return (
    <StatusCallout
      tone="danger"
      variant="strip"
      action={
        <>
          {hasStartupScript && initOutput && (
            <Button variant="ghost" size="xs" onClick={() => setExpanded(!expanded)}>
              {expanded ? <CaretDownIcon /> : <CaretRightIcon />}
              {expanded ? 'Hide output' : 'Show output'}
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={retry}
            pending={retryInit.isPending}
            pendingLabel="Retrying…"
            disabled={retryAvailability?.status !== 'AVAILABLE'}
          >
            <ArrowsClockwiseIcon />
            Retry
          </Button>
          {showPlay && (
            <Button variant="outline" size="xs" onClick={onPlay} disabled={!onPlay}>
              <PlayIcon />
              Dispatch queued messages
            </Button>
          )}
          {showDismiss && (
            <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label="Dismiss">
              <XIcon />
            </Button>
          )}
        </>
      }
    >
      <p>Init script failed{initErrorMessage ? `: ${initErrorMessage}` : ''}</p>
      {retryAvailability?.status !== 'AVAILABLE' && (
        <p className="mt-1 text-xs">
          {retryAvailability?.status === 'BLOCKED'
            ? retryAvailability.explanation
            : 'Checking setup retry availability…'}
        </p>
      )}
      {expanded && hasStartupScript && (
        <InitOutputPanel
          output={initOutput}
          className="mt-2 h-32 w-full rounded-md border bg-background"
        />
      )}
    </StatusCallout>
  );
}

// =============================================================================
// Archiving Overlay
// =============================================================================

export function ArchivingOverlay() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-md">
      <div role="status" className="flex items-center gap-3 p-8">
        <Spinner aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Archiving…</p>
      </div>
    </div>
  );
}
