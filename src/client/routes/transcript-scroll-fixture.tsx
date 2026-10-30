import { useRef, useState } from 'react';
import { VirtualizedMessageList } from '@/client/features/chat';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import type { GroupedMessageItem } from '@/lib/chat-protocol';
import { TranscriptEngineFixture } from './transcript-engine-fixture';

function message(index: number): GroupedMessageItem {
  return {
    id: `m-${index}`,
    source: 'user',
    text: `Message ${index}. ${'Transcript output wraps naturally. '.repeat(8)}`,
    order: index,
    timestamp: '2026-10-30T00:00:00Z',
  };
}

export default function TranscriptScrollFixture() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const scroll = useAutoScroll(viewportRef);
  const [messages, setMessages] = useState(() => Array.from({ length: 40 }, (_, i) => message(i)));
  const [hidden, setHidden] = useState(false);
  const [height, setHeight] = useState(360);
  if (new URLSearchParams(location.search).get('engine') === '1') {
    return <TranscriptEngineFixture />;
  }
  return (
    <main className="bg-background text-foreground p-2">
      <div className="flex flex-wrap gap-2 pb-2">
        <button
          type="button"
          onClick={() =>
            setMessages((items) => [
              ...items,
              ...Array.from({ length: 100 }, (_, i) => message(items.length + i)),
            ])
          }
        >
          Append burst
        </button>
        <button type="button" onClick={() => setHidden((value) => !value)}>
          Hide or show
        </button>
        <button type="button" onClick={() => setHeight((value) => (value === 360 ? 220 : 360))}>
          Resize viewport
        </button>
        <button type="button" onClick={scroll.scrollToBottom}>
          Jump latest
        </button>
      </div>
      <div style={{ height, display: hidden ? 'none' : 'block' }}>
        <div ref={viewportRef} data-testid="transcript-viewport" className="h-full overflow-y-auto">
          <VirtualizedMessageList
            messages={messages}
            running={false}
            startingSession={false}
            loadingSession={false}
            scrollContainerRef={viewportRef}
            onScroll={scroll.onScroll}
            isNearBottom={scroll.isNearBottom}
          />
        </div>
      </div>
    </main>
  );
}
