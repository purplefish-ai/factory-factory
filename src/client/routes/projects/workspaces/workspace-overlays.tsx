import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { InitOutputPanel } from './init-output-panel';
import { useRetryWorkspaceInit } from './use-retry-workspace-init';

// =============================================================================
// Script Failed Banner (non-blocking)
// =============================================================================

interface ScriptFailedBannerProps {
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
  initErrorMessage,
  initOutput,
  hasStartupScript,
  showPlay = false,
  onPlay,
  showDismiss = false,
  onDismiss,
}: ScriptFailedBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const { retry, retryInit } = useRetryWorkspaceInit(workspaceId);

  return (
    <div className="border-b bg-destructive/10 px-4 py-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2 text-sm text-destructive">
          <WarningIcon className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words whitespace-normal">
            Init script failed{initErrorMessage ? `: ${initErrorMessage}` : ''}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 self-start sm:justify-end">
          {hasStartupScript && initOutput && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <CaretDownIcon className="h-3 w-3 mr-1" />
              ) : (
                <CaretRightIcon className="h-3 w-3 mr-1" />
              )}
              {expanded ? 'Hide output' : 'Show output'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={retry}
            disabled={retryInit.isPending}
          >
            {retryInit.isPending ? (
              <>
                <SpinnerGapIcon className="h-3 w-3 mr-1 animate-spin" />
                Retrying...
              </>
            ) : (
              <>
                <ArrowsClockwiseIcon className="h-3 w-3 mr-1" />
                Retry
              </>
            )}
          </Button>
          {showPlay && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onPlay}
              disabled={!onPlay}
            >
              <PlayIcon className="h-3 w-3 mr-1" />
              Dispatch queued messages
            </Button>
          )}
          {showDismiss && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={onDismiss}
              aria-label="Dismiss"
            >
              <XIcon className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      {expanded && hasStartupScript && (
        <InitOutputPanel
          output={initOutput}
          className="mt-2 h-32 w-full rounded-md border bg-zinc-950"
        />
      )}
    </div>
  );
}

// =============================================================================
// Archiving Overlay
// =============================================================================

export function ArchivingOverlay() {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-md">
      <div className="flex items-center gap-3 p-8">
        {/* Simple spinner */}
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-muted-foreground" />
        {/* Grayed out text */}
        <p className="text-sm text-muted-foreground">Archiving...</p>
      </div>
    </div>
  );
}
