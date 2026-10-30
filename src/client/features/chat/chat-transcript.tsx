import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { memo, type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { TranscriptDisplayProps } from './transcript-display.types';
import { useTranscriptLayout } from './transcript-layout';
import { TranscriptRows } from './transcript-rows';
import type { TranscriptScrollOptions } from './transcript-scroll.types';
import { useTranscriptScroll } from './use-transcript-scroll';

export interface ChatTranscriptProps extends TranscriptDisplayProps {
  scroll: TranscriptScrollOptions;
  header?: ReactNode;
  label?: string;
}

function TranscriptInstance({
  scroll,
  header,
  label = 'Conversation',
  ...props
}: ChatTranscriptProps) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const display = { ...props, loadingSession: props.loadingSession || !scroll.ready };
  const layout = useTranscriptLayout(display, Boolean(header));
  const { engine, totalSize, state, jumpToLatest } = useTranscriptScroll(
    viewport,
    layout.keys,
    scroll
  );
  return (
    <div className="relative flex-1 min-h-12 h-full">
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
        />
      </div>
      {state.intent === 'reading' && scroll.ready && (
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
  );
}

/** Identity includes workspace, session and surface; old engine state cannot leak. */
export const ChatTranscript = memo(function ChatTranscript(props: ChatTranscriptProps) {
  return <TranscriptInstance key={props.scroll.identity} {...props} />;
});
