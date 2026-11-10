import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy';
import { useId, useState } from 'react';
import { StatusCallout } from '@/client/components/status-callout';
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
    <time className={cn('shrink-0 whitespace-nowrap text-xs', className)} dateTime={timestamp}>
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
    <StatusCallout
      tone="danger"
      data-testid="session-lifecycle-message"
      data-severity="error"
      data-expanded={expanded}
      title={expanded ? 'Error details' : undefined}
      className={cn('my-2', className)}
      action={
        <>
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
          <span role="status" className="sr-only">
            {copied ? 'Error copied to the clipboard' : ''}
          </span>
        </>
      }
    >
      {expanded ? (
        <p
          id={detailsId}
          className="max-h-80 overflow-y-auto rounded-sm whitespace-pre-wrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {text}
        </p>
      ) : (
        <p id={detailsId} className="truncate" title={text}>
          {text}
        </p>
      )}
    </StatusCallout>
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
    <StatusCallout
      tone="warning"
      data-testid="session-lifecycle-message"
      data-severity="warning"
      className={cn('my-2', className)}
      action={<LifecycleTime timestamp={lifecycle.timestamp} className="mt-0.5" />}
    >
      <p>{lifecycle.message}</p>
    </StatusCallout>
  );
}
