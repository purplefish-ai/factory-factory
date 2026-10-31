// @vitest-environment jsdom
import { type ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ChatInput, ChatTranscript, UseChatWebSocketReturn } from '@/client/features/chat';
import type { ChatMessage } from '@/lib/chat-protocol';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import { QuickChatContent } from './quick-chat-content';

const input = vi.hoisted(() => vi.fn((_props: ComponentProps<typeof ChatInput>) => null));
const list = vi.hoisted(() => vi.fn((_props: ComponentProps<typeof ChatTranscript>) => null));
vi.mock('@/client/features/chat', async (importOriginal) => {
  const { useGroupedChatMessages } =
    await importOriginal<typeof import('@/client/features/chat')>();
  return {
    ChatTranscript: list,
    useGroupedChatMessages,
    ChatInput: input,
    PermissionPrompt: () => null,
    QuestionPrompt: () => null,
  };
});

describe('QuickChatContent composer and queue controls', () => {
  it.each([
    { promptInFlight: false, placeholder: 'Type a message...' },
    { promptInFlight: true, placeholder: 'Message will be queued...' },
    { promptInFlight: undefined, placeholder: 'Message will be queued...' },
  ])(
    'uses prompt ownership when promptInFlight=$promptInFlight',
    ({ promptInFlight, placeholder }) => {
      const chatState = {
        messages: [],
        queuedMessages: [],
        pendingMessages: new Map(),
        pendingRequest: { type: 'none' },
        sessionStatus: { phase: 'running' },
        sessionRuntime: {
          ...createInitialSessionRuntimeState(),
          phase: 'running',
          processState: 'alive',
          activity: 'WORKING',
          work:
            promptInFlight === undefined
              ? undefined
              : {
                  promptInFlight,
                  backgroundTasks: [{ id: 'preview', name: 'pnpm dev', kind: 'shell' }],
                  runningSubagents: 0,
                  activeGoals: 0,
                },
        },
      } as unknown as UseChatWebSocketReturn;
      const root = createRoot(document.createElement('div'));
      try {
        flushSync(() =>
          root.render(
            <QuickChatContent
              workspaceId="workspace-1"
              chatState={chatState}
              transcriptScroll={{
                identity: 'quick-story',
                active: true,
                ready: true,
                initialIntent: 'following',
                initialPosition: null,
              }}
            />
          )
        );
        expect(input.mock.lastCall?.[0].placeholder).toBe(placeholder);
        expect(input.mock.lastCall?.[0]).toMatchObject({
          running: true,
          promptInFlight: promptInFlight ?? true,
        });
      } finally {
        flushSync(() => root.unmount());
      }
    }
  );

  it('renders a final answer once when a lifecycle row precedes its matching result', () => {
    const messages: ChatMessage[] = [
      {
        id: 'answer',
        source: 'agent',
        order: 0,
        timestamp: '2026-10-30T12:00:00Z',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: 'The fix is ready.' },
        },
      },
      {
        id: 'lifecycle',
        source: 'agent',
        order: 1,
        timestamp: '2026-10-30T12:00:01Z',
        message: { type: 'system', subtype: 'subagent_finished', text: 'Review finished' },
      },
      {
        id: 'result',
        source: 'agent',
        order: 2,
        timestamp: '2026-10-30T12:00:02Z',
        message: { type: 'result', result: 'The fix is ready.' },
      },
    ];
    const chatState = {
      messages,
      queuedMessages: [],
      pendingMessages: new Map(),
      pendingRequest: { type: 'none' },
      sessionStatus: { phase: 'ready' },
      sessionRuntime: createInitialSessionRuntimeState(),
    } as unknown as UseChatWebSocketReturn;
    const root = createRoot(document.createElement('div'));
    try {
      flushSync(() =>
        root.render(
          <QuickChatContent
            workspaceId="workspace-1"
            chatState={chatState}
            transcriptScroll={{
              identity: 'quick-story',
              active: true,
              ready: true,
              initialIntent: 'following',
              initialPosition: null,
            }}
          />
        )
      );
      expect(list.mock.lastCall?.[0].messages?.map((item) => item.id)).toEqual([
        'answer',
        'lifecycle',
      ]);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it.each([
    {
      connected: true,
      promptInFlight: true,
      isCompacting: false,
      phase: 'running',
      available: true,
    },
    {
      connected: false,
      promptInFlight: true,
      isCompacting: false,
      phase: 'running',
      available: false,
    },
    {
      connected: true,
      promptInFlight: false,
      isCompacting: false,
      phase: 'running',
      available: false,
    },
    {
      connected: true,
      promptInFlight: true,
      isCompacting: true,
      phase: 'running',
      available: false,
    },
    {
      connected: true,
      promptInFlight: true,
      isCompacting: false,
      phase: 'stopping',
      available: false,
    },
  ])('offers steering only for a connected active prompt ($available)', (state) => {
    const steerQueuedMessage = vi.fn();
    const chatState = {
      messages: [],
      queuedMessages: [],
      pendingMessages: new Map(),
      pendingRequest: { type: 'none' },
      sessionStatus: { phase: state.phase },
      sessionRuntime: {
        ...createInitialSessionRuntimeState(),
        work: {
          promptInFlight: state.promptInFlight,
          backgroundTasks: [],
          runningSubagents: 0,
          activeGoals: 0,
        },
      },
      connected: state.connected,
      isCompacting: state.isCompacting,
      steerQueuedMessage,
    } as unknown as UseChatWebSocketReturn;
    const root = createRoot(document.createElement('div'));
    try {
      flushSync(() =>
        root.render(
          <QuickChatContent
            workspaceId="workspace-1"
            chatState={chatState}
            transcriptScroll={{
              identity: 'steering',
              active: true,
              ready: true,
              initialIntent: 'following',
              initialPosition: null,
            }}
          />
        )
      );
      expect(list.mock.lastCall?.[0].onSteerQueuedMessage).toBe(
        state.available ? steerQueuedMessage : undefined
      );
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('connects queue controls and composer attachments to shared chat state', () => {
    const removeQueuedMessage = vi.fn();
    const attachments = [
      {
        id: 'attachment-1',
        name: 'notes.txt',
        type: 'text/plain',
        size: 5,
        data: 'notes',
        contentType: 'text' as const,
      },
    ];
    const setInputAttachments = vi.fn();
    const chatState = {
      inputAttachments: attachments,
      setInputAttachments,
      messages: [],
      queuedMessages: [{ id: 'queued-1' }],
      pendingMessages: new Map(),
      pendingRequest: { type: 'none' },
      sessionStatus: { phase: 'running' },
      sessionRuntime: createInitialSessionRuntimeState(),
      removeQueuedMessage,
    } as unknown as UseChatWebSocketReturn;
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = () =>
      flushSync(() =>
        root.render(
          <QuickChatContent
            workspaceId="workspace-1"
            chatState={chatState}
            transcriptScroll={{
              identity: 'quick-story',
              active: true,
              ready: true,
              initialIntent: 'following',
              initialPosition: null,
            }}
          />
        )
      );
    try {
      render();
      expect(list.mock.lastCall?.[0]).toMatchObject({
        queuedMessageIds: new Set(['queued-1']),
        onRemoveQueuedMessage: removeQueuedMessage,
      });
      expect(input.mock.lastCall?.[0].attachments).toBe(attachments);
      input.mock.lastCall?.[0].onAttachmentsChange?.([]);
      expect(setInputAttachments).toHaveBeenCalledWith([]);
      chatState.inputAttachments = [];
      chatState.queuedMessages = [];
      render();
      expect(list.mock.lastCall?.[0]?.queuedMessageIds).toEqual(new Set());
      expect(input.mock.lastCall?.[0].attachments).toEqual([]);
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

vi.mock('@/client/features/subagents', () => ({
  useSubagentTimelineMessages: (messages: unknown[]) => ({ messages, error: null }),
}));
