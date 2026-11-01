import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { memo, type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ThinkingFooter } from './thinking-footer';
import type { TranscriptDisplayProps } from './transcript-display.types';
import { useTranscriptLayout } from './transcript-layout';
import { TranscriptRows } from './transcript-rows';
import type { TranscriptScrollOptions } from './transcript-scroll.types';
import { useTranscriptScroll } from './use-transcript-scroll';

export interface ChatTranscriptProps extends TranscriptDisplayProps {
  scroll: TranscriptScrollOptions;
  /** Reserve a thinking preview outside the scroller, directly above the composer. */
  thinkingInFooter?: boolean;
  header?: ReactNode;
  label?: string;
  contentClassName?: string;
}

function TranscriptInstance({
  scroll,
  thinkingInFooter = false,
  header,
  label = 'Conversation',
  contentClassName,
  ...props
}: ChatTranscriptProps) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const display = {
    ...props,
    hideThinkingIndicator: thinkingInFooter || props.hideThinkingIndicator,
    loadingSession: props.loadingSession || !scroll.ready,
  };
  const autonomousTurn = props.work?.backgroundTasks.some((task) => task.kind === 'turn') ?? false;
  const thinkingActive =
    !display.loadingSession &&
    (props.running || autonomousTurn) &&
    (props.work?.promptInFlight !== false || autonomousTurn);
  const layout = useTranscriptLayout(display, Boolean(header));
  const { engine, totalSize, state, hasContentBelow, jumpToLatest } = useTranscriptScroll(
    viewport,
    layout.keys,
    scroll
  );
  return (
    <div className="flex flex-1 min-h-12 h-full min-w-0 flex-col">
      <div className="relative flex-1 min-h-0">
        <div
          ref={setViewport}
          data-testid="transcript-viewport"
          role="log"
          aria-label={label}
          className="h-full overflow-y-auto min-w-0"
          style={{ overflowAnchor: 'none' }}
        >
          <TranscriptRows
            display={display}
            layout={layout}
            engine={engine}
            totalSize={totalSize}
            header={header}
            contentClassName={contentClassName}
          />
        </div>
        {state.intent === 'reading' && scroll.ready && hasContentBelow && (
          <div className="absolute bottom-2 left-0 right-0 z-10 flex justify-center pointer-events-none">
            <Button
              variant="secondary"
              size="sm"
              onClick={jumpToLatest}
              className="rounded-full pointer-events-auto"
            >
              <ArrowDownIcon className="h-4 w-4 mr-1" />
              Scroll to bottom
            </Button>
          </div>
        )}
      </div>
      {thinkingInFooter && (
        <ThinkingFooter active={thinkingActive} latestThinking={props.latestThinking} />
      )}
    </div>
  );
}

/** Identity includes workspace, session and surface; old engine state cannot leak. */
export const ChatTranscript = memo(function ChatTranscript(props: ChatTranscriptProps) {
  return <TranscriptInstance key={props.scroll.identity} {...props} />;
});
