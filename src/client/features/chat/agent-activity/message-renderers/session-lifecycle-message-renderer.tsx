import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { useId, useState } from 'react';
import { useCopyToClipboard } from '@/client/hooks/use-copy-to-clipboard';
import { Button } from '@/components/ui/button';
import type { AgentMessage } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';

interface SessionLifecycleMessageRendererProps {
  message: AgentMessage;
  className?: string;
}

const ERROR_REASONS = new Set(['PROVIDER_ERROR', 'UNEXPECTED_EXIT']);

function LifecycleTime({ timestamp, className }: { timestamp: string; className?: string }) {
  return (
    <time
      className={cn('shrink-0 whitespace-nowrap text-xs opacity-80', className)}
      dateTime={timestamp}
    >
      {new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(timestamp))}
    </time>
  );
}

/**
 * Provider errors can be long (JSON bodies, stack traces), so error rows start
 * as one line and expand inline to the full, selectable text with a Copy action.
 */
function ErrorLifecycleRow({
  text,
  timestamp,
  className,
}: {
  text: string;
  timestamp: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { copied, copy } = useCopyToClipboard();
  const detailsId = useId();
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;

  return (
    <div
      data-testid="session-lifecycle-message"
      data-severity="error"
      data-expanded={expanded}
      className={cn(
        'my-2 rounded-md border border-destructive/30 bg-destructive/5 text-sm text-destructive',
        className
      )}
    >
      <div className="flex items-center gap-2 py-1 pr-1 pl-3">
        <XCircleIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
        {expanded ? (
          <span className="min-w-0 flex-1 truncate font-medium">Error details</span>
        ) : (
          <p id={detailsId} className="min-w-0 flex-1 truncate" title={text}>
            {text}
          </p>
        )}
        <LifecycleTime timestamp={timestamp} />
        {expanded && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-destructive hover:text-destructive"
            aria-label={copied ? 'Error copied' : 'Copy error'}
            onClick={() => void copy(text)}
          >
            <CopyStateIcon aria-hidden="true" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-destructive hover:text-destructive"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={expanded ? 'Collapse error' : 'Show full error'}
          onClick={() => setExpanded((open) => !open)}
        >
          <CaretDownIcon
            aria-hidden="true"
            className={cn('transition-transform', expanded && 'rotate-180')}
          />
        </Button>
      </div>
      {expanded && (
        <p
          id={detailsId}
          className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2 pl-9 text-foreground"
        >
          {text}
        </p>
      )}
    </div>
  );
}

export function SessionLifecycleMessageRenderer({
  message,
  className,
}: SessionLifecycleMessageRendererProps): React.JSX.Element | null {
  if (!message.lifecycle) {
    return null;
  }

  const { lifecycle } = message;
  if (ERROR_REASONS.has(lifecycle.reason)) {
    return (
      <ErrorLifecycleRow
        text={lifecycle.message}
        timestamp={lifecycle.timestamp}
        className={className}
      />
    );
  }

  // Warnings are short system copy; they wrap instead of hiding text in a tooltip.
  return (
    <div
      data-testid="session-lifecycle-message"
      data-severity="warning"
      className={cn(
        'my-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-muted-foreground',
        className
      )}
    >
      <WarningCircleIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words">{lifecycle.message}</p>
      <LifecycleTime timestamp={lifecycle.timestamp} className="mt-0.5" />
    </div>
  );
}
