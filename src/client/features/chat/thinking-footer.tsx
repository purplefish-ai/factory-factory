import { useState } from 'react';
import { StatusIcon } from '@/client/components/status-indicators';
import { getPendingRequestPresentation } from '@/client/lib/pending-request-presentation';
import { getStatusToneStyle } from '@/client/lib/status-tones';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { PendingRequestType } from '@/shared/pending-request-types';
import { LoadingIndicator } from './agent-activity';
import { formatThinkingText, getLatestThinkingParagraph } from './thinking-preview';

const footerClassName = 'h-8 min-h-[var(--touch-target-size,2rem)] shrink-0 min-w-0 px-4';

/** Replaces the spinner while the agent is blocked on the user. */
function WaitingForUser({ type }: { type: PendingRequestType }) {
  const request = getPendingRequestPresentation(type);
  return (
    <div data-testid="thinking-footer" data-waiting-for={type} className={footerClassName}>
      <div
        role="status"
        className={cn(
          'flex h-full min-w-0 items-center gap-2 text-sm leading-normal',
          getStatusToneStyle('attention').text
        )}
      >
        <StatusIcon tone="attention" icon={request.icon} className="h-4 w-4" />
        <span className="truncate">{request.waitingText}</span>
      </div>
    </div>
  );
}

/** Always occupies one line; activity changes cannot resize the transcript viewport. */
export function ThinkingFooter({
  active,
  isCompacting = false,
  latestThinking,
  waitingFor = null,
}: {
  active: boolean;
  isCompacting?: boolean;
  latestThinking?: string | null;
  /** The request the agent is blocked on; shown instead of "Agent is working". */
  waitingFor?: PendingRequestType | null;
}) {
  const [open, setOpen] = useState(false);
  if ((!active || isCompacting || waitingFor) && open) {
    setOpen(false);
  }
  if (isCompacting) {
    return (
      <div data-testid="thinking-footer" className={footerClassName}>
        <div role="status" className="flex h-full items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          <span>Compacting</span>
        </div>
      </div>
    );
  }
  if (active && waitingFor) {
    return <WaitingForUser type={waitingFor} />;
  }
  const latestParagraph = getLatestThinkingParagraph(latestThinking);
  return (
    <div data-testid="thinking-footer" className={footerClassName}>
      <div
        inert={!active}
        className={cn(
          'h-full transition-opacity duration-150 motion-reduce:transition-none',
          active ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
        <span role="status" className="sr-only">
          {active ? 'Agent is working' : ''}
        </span>
        <Popover open={active && open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!active}
              tabIndex={active ? 0 : -1}
              aria-label="Show thinking preview"
              className="block h-full w-full min-w-0 rounded-sm text-left focus-ring"
            >
              <LoadingIndicator latestReasoning={latestParagraph} singleLine plainText />
            </button>
          </PopoverTrigger>
          <PopoverContent
            onCloseAutoFocus={(event) => {
              if (!active) {
                event.preventDefault();
              }
            }}
            side="top"
            align="start"
            aria-label="Thinking preview"
            className="max-h-60 max-w-[calc(100vw-2rem)] overflow-y-auto whitespace-pre-wrap break-words text-sm motion-reduce:animate-none"
          >
            {formatThinkingText(latestThinking) || 'Agent is working…'}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
