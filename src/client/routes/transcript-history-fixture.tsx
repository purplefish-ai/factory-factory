import { useReducer, useRef } from 'react';
import { ChatTranscript, useGroupedChatMessages } from '@/client/features/chat';
import { chatReducer, createInitialChatState } from '@/client/features/chat/reducer';
import { useTranscriptHistory } from '@/client/features/chat/use-transcript-history';
import type { ChatMessage } from '@/lib/chat-protocol';

function tool(order: number): ChatMessage {
  return {
    id: `tool-${order}`,
    source: 'agent',
    order,
    timestamp: '2026-11-04T00:00:00Z',
    message: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: `call-${order}`,
          name: 'Read',
          input: { file_path: `file-${order}.ts` },
        },
      },
    },
  };
}

/** Real paging reducer and grouping, with a manually resolved history transport. */
export function TranscriptHistoryFixture() {
  const [state, dispatch] = useReducer(chatReducer, undefined, () =>
    createInitialChatState({
      sessionStatus: { phase: 'ready' },
      messages: [
        {
          id: 'hidden-thinking',
          source: 'agent',
          order: 99,
          timestamp: '2026-11-04T00:00:00Z',
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'Earlier reasoning' }],
            },
          },
        },
        tool(100),
        tool(101),
        ...Array.from({ length: 40 }, (_, index): ChatMessage => ({
          id: `message-${index}`,
          source: 'user',
          order: index + 102,
          text: `Message ${index}. ${'Transcript output. '.repeat(20)}`,
          timestamp: '2026-11-04T00:00:00Z',
        })),
      ],
    })
  );
  const pending = useRef<((page: { messages: ChatMessage[]; hasMore: boolean }) => void) | null>(
    null
  );
  const history = useTranscriptHistory({
    sessionId: 'history-tools',
    enabled: true,
    messages: state.messages,
    history: state.transcriptHistory,
    dispatch,
    fetchPage: () =>
      new Promise((resolve) => {
        pending.current = resolve;
      }),
  });
  const messages = useGroupedChatMessages(state.messages, {
    groupBoundaries: state.transcriptPageBoundaries,
  });
  return (
    <main className="bg-background text-foreground p-2">
      <button
        type="button"
        onClick={() =>
          pending.current?.({
            messages: Array.from({ length: 99 }, (_, index) => tool(index)),
            hasMore: false,
          })
        }
      >
        Resolve tools page
      </button>
      <div style={{ height: 400 }}>
        <ChatTranscript
          messages={messages}
          history={history}
          running={false}
          startingSession={false}
          loadingSession={false}
          scroll={{
            identity: 'history-tools',
            active: true,
            ready: true,
            initialIntent: 'following',
            initialPosition: null,
          }}
        />
      </div>
    </main>
  );
}
