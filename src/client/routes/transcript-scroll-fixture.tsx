import { useState } from 'react';
import { ChatTranscript } from '@/client/features/chat';
import { WorkspacePanelProvider, useChatTranscriptPersistence } from '@/client/features/workspace';
import { type GroupedMessageItem, isToolSequence } from '@/lib/chat-protocol';
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
function tools(count: number): GroupedMessageItem {
  return {
    type: 'tool_sequence',
    id: 'tool-group',
    pairedCalls: Array.from({ length: count }, (_, i) => ({
      id: `call-${i}`,
      name: 'Read',
      input: { file_path: `file-${i}.ts` },
      status: 'success',
      result: { content: 'File output', isError: false },
    })),
  };
}

function TranscriptFixtureContent({ workspaceId }: { workspaceId: string }) {
  const [session, setSession] = useState<'A' | 'B'>('A');
  const [data, setData] = useState<Record<'A' | 'B', GroupedMessageItem[]>>(() => ({
    A: Array.from({ length: 40 }, (_, i) => message(i)),
    B: Array.from({ length: 20 }, (_, i) => message(i)),
  }));
  const [hidden, setHidden] = useState(false);
  const [ready, setReady] = useState(true);
  const [running, setRunning] = useState(false);
  const [height, setHeight] = useState(360);
  const [narrow, setNarrow] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(24);
  const persistence = useChatTranscriptPersistence({ workspaceId, sessionId: session });
  const update = (change: (messages: GroupedMessageItem[]) => GroupedMessageItem[]) =>
    setData((previous) => ({ ...previous, [session]: change(previous[session]) }));
  return (
    <main className="bg-background text-foreground p-2">
      <div className="flex flex-wrap gap-2 pb-2">
        <button
          type="button"
          onClick={() =>
            update((items) => [
              ...items,
              ...Array.from({ length: 100 }, (_, i) => message(items.length + i)),
            ])
          }
        >
          Append burst
        </button>
        <button
          type="button"
          onClick={() =>
            update((items) => {
              const last = items.at(-1);
              return last && isToolSequence(last)
                ? [...items.slice(0, -1), tools(last.pairedCalls.length + 100)]
                : [...items, tools(2)];
            })
          }
        >
          Tool burst
        </button>
        <button
          type="button"
          onClick={() =>
            update((items) => [
              ...Array.from({ length: 10 }, (_, i) => message(-items.length - i - 1)),
              ...items,
            ])
          }
        >
          Prepend history
        </button>
        <button type="button" onClick={() => update((items) => items.slice(0, 2))}>
          Rewind
        </button>
        <button type="button" onClick={() => setHidden((value) => !value)}>
          Hide or show
        </button>
        <button type="button" onClick={() => setHeight((value) => (value === 360 ? 220 : 360))}>
          Resize viewport
        </button>
        <button type="button" onClick={() => setNarrow((value) => !value)}>
          Resize width
        </button>
        <button type="button" onClick={() => setSession((value) => (value === 'A' ? 'B' : 'A'))}>
          Switch session
        </button>
        <button type="button" onClick={() => setRunning((value) => !value)}>
          Toggle activity
        </button>
        <button type="button" onClick={() => setReady((value) => !value)}>
          Toggle hydration
        </button>
        <button type="button" onClick={() => setHeaderHeight((value) => (value === 24 ? 240 : 24))}>
          Resize image header
        </button>
        <output>Session {session}</output>
      </div>
      <div style={{ height, width: narrow ? '80%' : '100%', display: hidden ? 'none' : 'block' }}>
        <ChatTranscript
          messages={data[session]}
          running={running}
          latestThinking="Inspecting output"
          startingSession={false}
          loadingSession={false}
          header={
            <div role="img" style={{ height: headerHeight }} aria-label="Measured image header" />
          }
          scroll={{
            identity: `${workspaceId}/main/${session}`,
            active: !hidden,
            ready: ready && persistence.ready,
            initialIntent: 'following',
            initialPosition: persistence.initialPosition,
            onPositionChange: persistence.onPositionChange,
          }}
        />
      </div>
    </main>
  );
}

export default function TranscriptScrollFixture() {
  const [workspaceId, setWorkspaceId] = useState('fixture-W1');
  if (new URLSearchParams(location.search).get('engine') === '1') {
    return <TranscriptEngineFixture />;
  }
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setWorkspaceId((value) => (value === 'fixture-W1' ? 'fixture-W2' : 'fixture-W1'))
        }
      >
        Switch workspace
      </button>
      <WorkspacePanelProvider workspaceId={workspaceId}>
        <TranscriptFixtureContent workspaceId={workspaceId} />
      </WorkspacePanelProvider>
    </>
  );
}
