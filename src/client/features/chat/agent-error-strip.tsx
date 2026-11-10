import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { StatusIcon } from '@/client/components/status-indicators';
import { useCopyToClipboard } from '@/client/hooks/use-copy-to-clipboard';
import { getStatusToneStyle } from '@/client/lib/status-tones';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface AgentErrorStripProps {
  message: string;
  /** Resends the last message. Omit when there is nothing to resend. */
  onRetry?: () => void;
  /** Stops and restarts the agent, resuming its conversation. */
  onRestart?: () => void;
  /** A restart is in flight: Restart agent shows a spinner and is disabled. */
  restartPending?: boolean;
  onDismiss?: () => void;
  /** Disables Retry, e.g. while the chat connection is down. */
  retryDisabled?: boolean;
  className?: string;
}

/**
 * The current agent runtime error, pinned above the composer so it stays visible
 * however far the transcript scrolls, with the actions that recover from it.
 */
export function AgentErrorStrip({
  message,
  onRetry,
  onRestart,
  restartPending = false,
  onDismiss,
  retryDisabled = false,
  className,
}: AgentErrorStripProps) {
  const { copied, copy } = useCopyToClipboard();
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;

  return (
    <section
      aria-label="Agent error"
      data-testid="agent-error-strip"
      className={cn(
        'mx-4 mt-2 flex flex-col gap-2 rounded-md border px-3 py-2 text-sm',
        getStatusToneStyle('danger').surface,
        className
      )}
    >
      <div className="flex items-start gap-2">
        <StatusIcon tone="danger" icon={XCircleIcon} className="mt-0.5 h-4 w-4" />
        <div role="alert" className="min-w-0 flex-1">
          <p className="font-medium">Agent error</p>
          <p className="mt-0.5 max-h-24 overflow-y-auto rounded-sm whitespace-pre-wrap break-words text-foreground focus-ring">
            {message}
          </p>
        </div>
        {onDismiss && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="-my-1 -mr-2 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss error"
            onClick={onDismiss}
          >
            <XIcon aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6 text-foreground">
        {onRetry && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            title="Send your last message again"
            disabled={retryDisabled}
            onClick={onRetry}
          >
            <ArrowCounterClockwiseIcon aria-hidden="true" />
            Retry
          </Button>
        )}
        {onRestart && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            title="Stop and restart the agent, resuming from where it left off"
            pending={restartPending}
            pendingLabel="Restarting…"
            onClick={onRestart}
          >
            <ArrowsClockwiseIcon aria-hidden="true" />
            Restart agent
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => void copy(message)}
        >
          <CopyStateIcon aria-hidden="true" />
          {copied ? 'Copied' : 'Copy error'}
        </Button>
        <span role="status" className="sr-only">
          {copied ? 'Error copied to the clipboard' : ''}
        </span>
      </div>
    </section>
  );
}
