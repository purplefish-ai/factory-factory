import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { memo, type ReactNode, useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import type { PendingRequestType } from '@/shared/pending-request-types';
import { StickyUserMessage } from './sticky-user-message';
import { ThinkingFooter } from './thinking-footer';
import type { TranscriptDisplayProps } from './transcript-display.types';
import { TranscriptHistoryHeader } from './transcript-history-header';
import { useTranscriptLayout } from './transcript-layout';
import { TranscriptRows } from './transcript-rows';
import type { TranscriptScrollOptions } from './transcript-scroll.types';
import type { TranscriptHistoryControls } from './use-transcript-history';
import { useTranscriptScroll } from './use-transcript-scroll';

export interface ChatTranscriptProps extends TranscriptDisplayProps {
  scroll: TranscriptScrollOptions;
  /** Reserve a thinking preview outside the scroller, directly above the composer. */
  thinkingInFooter?: boolean;
  /** A request blocking the agent on the user; the footer says so instead of "working". */
  pendingRequestType?: PendingRequestType | null;
  header?: ReactNode;
  history?: TranscriptHistoryControls;
  label?: string;
  contentClassName?: string;
}

function TranscriptInstance({
  scroll,
  thinkingInFooter = false,
  pendingRequestType = null,
  header: banner,
  history,
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
  // Keep the row identity stable while paging; only its contents change.
  const header = history ? (
    <>
      {banner}
      <TranscriptHistoryHeader history={history} />
    </>
  ) : (
    banner
  );
  const layout = useTranscriptLayout(display, Boolean(header));
  const { engine, totalSize, state, hasContentBelow, jumpToLatest, jumpToMessage } =
    useTranscriptScroll(viewport, layout.keys, scroll, Boolean(history));
  useEffect(() => {
    if (
      !(viewport && history) ||
      history.status !== 'idle' ||
      history.enabled === false ||
      state.phase !== 'ready' ||
      !scroll.active ||
      display.loadingSession
    ) {
      return;
    }
    const loadNearTop = () => {
      if (viewport.scrollTop < 400) {
        history.loadOlder();
      }
    };
    loadNearTop();
    viewport.addEventListener('scroll', loadNearTop, { passive: true });
    return () => viewport.removeEventListener('scroll', loadNearTop);
  }, [viewport, history, state.phase, scroll.active, display.loadingSession]);
  return (
    <div className="flex flex-1 min-h-24 h-full min-w-0 flex-col">
      <div className="relative flex-1 min-h-0">
        <div
          ref={setViewport}
          data-testid="transcript-viewport"
          role="log"
          aria-label={label}
          className="h-full overflow-y-auto min-w-0"
          // TanStack performs above-viewport compensation, so CSS anchoring is off.
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
        <StickyUserMessage
          viewport={viewport}
          engine={engine}
          messages={layout.messages}
          headerOffset={layout.headerOffset}
          queuedMessageIds={props.queuedMessageIds}
          pendingMessageIds={layout.pendingMessageIds}
          enabled={
            scroll.active && scroll.ready && !display.loadingSession && state.phase === 'ready'
          }
          onJump={jumpToMessage}
        />
        {state.intent === 'reading' && scroll.ready && hasContentBelow && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              onClick={jumpToLatest}
              className="pointer-events-auto rounded-full"
            >
              <ArrowDownIcon />
              Scroll to bottom
            </Button>
          </div>
        )}
      </div>
      {thinkingInFooter && (
        <ThinkingFooter
          active={thinkingActive}
          latestThinking={props.latestThinking}
          waitingFor={pendingRequestType}
        />
      )}
    </div>
  );
}

/** Identity includes workspace, session and surface; old engine state cannot leak. */
export const ChatTranscript = memo(function ChatTranscript(props: ChatTranscriptProps) {
  return <TranscriptInstance key={props.scroll.identity} {...props} />;
});
