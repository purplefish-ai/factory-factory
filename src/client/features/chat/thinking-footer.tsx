import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { LoadingIndicator } from './agent-activity';
import { formatThinkingText, getLatestThinkingParagraph } from './thinking-preview';

/** Always occupies one line; activity changes cannot resize the transcript viewport. */
export function ThinkingFooter({
  active,
  latestThinking,
}: {
  active: boolean;
  latestThinking?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const latestParagraph = getLatestThinkingParagraph(latestThinking);
  if (!active && open) {
    setOpen(false);
  }
  return (
    <div data-testid="thinking-footer" className="h-8 shrink-0 min-w-0 px-4 py-1.5">
      <div
        inert={!active}
        className={cn(
          'transition-opacity duration-150 motion-reduce:transition-none',
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
              className="block w-full min-w-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            {formatThinkingText(latestThinking) || 'Agent is working...'}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
