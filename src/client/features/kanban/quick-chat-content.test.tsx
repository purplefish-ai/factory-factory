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
  const { getChatPendingRequestType, useGroupedChatMessages, useTranscriptSend } =
    await importOriginal<typeof import('@/client/features/chat')>();
  return {
    ChatTranscript: list,
    getChatPendingRequestType,
    useGroupedChatMessages,
    useTranscriptSend,
    ChatInput: input,
    PermissionPrompt: () => null,
    QuestionPrompt: () => null,
  };
});

describe('QuickChatContent composer and queue controls', () => {
  it.each([
    { promptInFlight: false, placeholder: 'Type a message…' },
    { promptInFlight: true, placeholder: 'Message will be queued…' },
    { promptInFlight: undefined, placeholder: 'Message will be queued…' },
  ])(
    'uses prompt ownership when promptInFlight=$promptInFlight',
    ({ promptInFlight, placeholder }) => {
      const chatState = {
        runtimeSessionId: 'quick-chat-disclosures',
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
        expect(list.mock.lastCall?.[0].sessionId).toBe('quick-chat-disclosures');
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

  it.each([
    {
      pendingRequest: {
        type: 'permission',
        request: { requestId: 'r-1', toolName: 'Bash', toolInput: { command: 'ls' } },
      },
      pendingRequestType: 'permission_request',
      placeholder: 'Respond to the request above, or queue a message…',
    },
    {
      pendingRequest: {
        type: 'question',
        request: { requestId: 'r-2', toolName: 'AskUserQuestion', questions: [] },
      },
      pendingRequestType: 'user_question',
      placeholder: 'Answer the question above, or queue a message…',
    },
    {
      pendingRequest: {
        type: 'question',
        request: { requestId: 'r-3', toolName: 'ExitPlanMode', questions: [] },
      },
      pendingRequestType: 'plan_approval',
      placeholder: 'Approve the plan or keep planning…',
    },
  ])(
    'tells the footer and composer the agent waits on a $pendingRequestType',
    ({ pendingRequest, pendingRequestType, placeholder }) => {
      const chatState = {
        runtimeSessionId: 'quick-chat-waiting',
        messages: [],
        queuedMessages: [],
        pendingMessages: new Map(),
        pendingRequest,
        sessionStatus: { phase: 'running' },
        sessionRuntime: {
          ...createInitialSessionRuntimeState(),
          phase: 'running',
          processState: 'alive',
          activity: 'WORKING',
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
        expect(list.mock.lastCall?.[0].pendingRequestType).toBe(pendingRequestType);
        expect(input.mock.lastCall?.[0].placeholder).toBe(placeholder);
        flushSync(() =>
          root.render(
            <QuickChatContent
              workspaceId="workspace-1"
              chatState={{
                ...chatState,
                sessionRuntime: { ...chatState.sessionRuntime, processState: 'stopped' },
              }}
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
        expect(list.mock.lastCall?.[0].pendingRequestType).toBeNull();
        expect(input.mock.lastCall?.[0].placeholder).not.toBe(placeholder);
        flushSync(() =>
          root.render(
            <QuickChatContent
              workspaceId="workspace-1"
              chatState={{
                ...chatState,
                sessionStatus: { phase: 'stopping' },
                sessionRuntime: { ...chatState.sessionRuntime, phase: 'stopping' },
              }}
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
        expect(input.mock.lastCall?.[0].placeholder).toBe('Stopping…');
        expect(list.mock.lastCall?.[0].pendingRequestType).toBeNull();
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
    const sendMessage = vi.fn();
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
      sendMessage,
    } as unknown as UseChatWebSocketReturn;
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (identity = 'quick-story') =>
      flushSync(() =>
        root.render(
          <QuickChatContent
            workspaceId="workspace-1"
            chatState={chatState}
            transcriptScroll={{
              identity,
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
      expect(list.mock.lastCall?.[0].scroll.followRequest).toBeUndefined();
      flushSync(() => input.mock.lastCall?.[0].onSend('Continue'));
      expect(sendMessage).toHaveBeenCalledWith('Continue', undefined);
      const request = list.mock.lastCall?.[0].scroll.followRequest;
      expect(request).toBeDefined();
      expect(input.mock.lastCall?.[0].attachments).toBe(attachments);
      input.mock.lastCall?.[0].onAttachmentsChange?.([]);
      expect(setInputAttachments).toHaveBeenCalledWith([]);
      chatState.inputAttachments = [];
      chatState.queuedMessages = [];
      render();
      expect(list.mock.lastCall?.[0]?.queuedMessageIds).toEqual(new Set());
      expect(input.mock.lastCall?.[0].attachments).toEqual([]);
      expect(list.mock.lastCall?.[0].scroll.followRequest).toBe(request);
      render('another-session');
      expect(list.mock.lastCall?.[0].scroll.followRequest).toBeUndefined();
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

vi.mock('@/client/features/subagents', () => ({
  useSubagentTimelineMessages: (messages: unknown[]) => ({ messages, error: null }),
}));
