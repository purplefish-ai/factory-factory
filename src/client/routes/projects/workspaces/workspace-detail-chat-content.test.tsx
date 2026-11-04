// @vitest-environment jsdom
import { createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';

const transcript = vi.hoisted(() => vi.fn());
const input = vi.hoisted(() => vi.fn((_props: { placeholder: string }) => null));
const subagentState = vi.hoisted(() => ({
  siblingStatus: 'completed' as 'completed' | 'starting' | 'waiting' | 'running',
}));

const defaultScrollProps = {
  transcriptScroll: {
    identity: 'test',
    active: true,
    ready: true,
    initialIntent: 'following' as const,
    initialPosition: null,
  },
};

vi.mock('@/client/features/chat', async () => ({
  getChatPendingRequestType: (
    await vi.importActual<typeof import('@/client/features/chat/pending-request-type')>(
      '@/client/features/chat/pending-request-type'
    )
  ).getChatPendingRequestType,
  useTranscriptSend: (
    await vi.importActual<typeof import('@/client/features/chat/use-transcript-send')>(
      '@/client/features/chat/use-transcript-send'
    )
  ).useTranscriptSend,
  AgentErrorStrip: (
    await vi.importActual<typeof import('@/client/features/chat/agent-error-strip')>(
      '@/client/features/chat/agent-error-strip'
    )
  ).AgentErrorStrip,
  useGroupedChatMessages: () => [],
  ChatTranscript: (props: { header?: React.ReactNode }) => {
    transcript(props);
    return props.header;
  },
  ChatInput: input,
  PermissionPrompt: () => null,
  QuestionPrompt: () => null,
  RewindConfirmationDialog: () => null,
}));
vi.mock('@/client/features/voice', () => ({ VoiceModeToggle: () => null }));
vi.mock('./use-retry-workspace-init', () => ({
  useRetryWorkspaceInit: () => ({ retry: vi.fn(), retryInit: { isPending: false } }),
}));

describe('ChatContent init banner ownership', () => {
  it.each(['warning', 'error'] as const)(
    'leaves %s script failures to the workspace banner',
    (kind) => {
      const props = {
        ...defaultScrollProps,
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        messages: [],
        queuedMessages: [],
        sessionStatus: { phase: 'ready' },
        sessionRuntime: createInitialSessionRuntimeState(),
        chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
        pendingRequest: { type: 'none' },
        pendingMessages: new Map(),
        inputRef: createRef(),
        initBanner: {
          kind,
          message: 'Init script failed',
          showRetry: true,
          showPlay: false,
          showDismiss: true,
        },
        isScriptFailed: true,
      } as unknown as ChatContentProps;
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        flushSync(() => root.render(<ChatContent {...props} />));
        expect(container.textContent).not.toContain('Init script failed');
        expect(transcript.mock.lastCall?.[0].header).toBeUndefined();
        flushSync(() => root.render(<ChatContent {...props} isScriptFailed={false} />));
        expect(container.textContent).toContain('Init script failed');
        expect(container.textContent).toContain('Retry setup');
      } finally {
        flushSync(() => root.unmount());
      }
    }
  );
});

describe('ChatContent runtime error placeholder', () => {
  it.each([
    { processState: 'alive' as const, errorMessage: 'Request timed out' },
    { processState: 'stopped' as const, errorMessage: 'Agent startup failed' },
    {
      processState: 'stopped' as const,
      lastExit: {
        code: 137,
        timestamp: '2026-09-17T00:00:00Z',
        unexpected: true,
      },
    },
  ])('uses accurate retry wording for $processState runtime errors', (runtime) => {
    const props = {
      ...defaultScrollProps,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      messages: [],
      queuedMessages: [],
      sessionStatus: { phase: 'ready' },
      sessionRuntime: { ...createInitialSessionRuntimeState(), ...runtime, phase: 'error' },
      chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
      pendingRequest: { type: 'none' },
      pendingMessages: new Map(),
      inputRef: createRef(),
    } as unknown as ChatContentProps;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ChatContent {...props} />));
      const strip = container.querySelector('[data-testid="agent-error-strip"]');
      expect(strip?.querySelector('[role="alert"]')?.textContent).toContain(
        runtime.errorMessage ?? 'Exited unexpectedly (code 137)'
      );
      expect(transcript.mock.lastCall?.[0].header).toBeUndefined();
      expect(input.mock.lastCall?.[0].placeholder).toBe(
        "Couldn't continue this chat. Type a message to retry…"
      );
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

describe('ChatContent agent error strip', () => {
  const lastUserMessage = {
    id: 'user-2',
    source: 'user',
    text: 'Run the migration again',
    attachments: [
      {
        id: 'notes',
        name: 'notes.txt',
        type: 'text/plain',
        contentType: 'text',
        size: 5,
        data: 'notes',
      },
    ],
    timestamp: '2026-09-17T00:00:00Z',
    order: 2,
  };

  function errorProps(overrides: Partial<ChatContentProps> = {}) {
    return {
      ...defaultScrollProps,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      messages: [
        {
          id: 'user-1',
          source: 'user',
          text: 'First',
          timestamp: '2026-09-17T00:00:00Z',
          order: 1,
        },
        lastUserMessage,
      ],
      queuedMessages: [],
      sessionStatus: { phase: 'ready' },
      sessionRuntime: {
        ...createInitialSessionRuntimeState(),
        phase: 'error',
        processState: 'alive',
        errorMessage: 'Provider returned HTTP 529 (Overloaded)',
      },
      chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
      pendingRequest: { type: 'none' },
      pendingMessages: new Map(),
      inputRef: createRef(),
      connected: true,
      sendMessage: vi.fn(),
      restartSession: vi.fn(),
      ...overrides,
    } as unknown as ChatContentProps;
  }

  function button(container: HTMLElement, name: string) {
    return [...container.querySelectorAll('button')].find(
      (element) => element.textContent === name || element.getAttribute('aria-label') === name
    );
  }

  it('retries by resending the last user message without touching the draft', () => {
    const props = errorProps();
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ChatContent {...props} />));
      expect(transcript.mock.lastCall?.[0].scroll.followRequest).toBeUndefined();
      flushSync(() => button(container, 'Retry')?.click());
      expect(transcript.mock.lastCall?.[0].scroll.followRequest).toBeDefined();
      expect(props.sendMessage).toHaveBeenCalledWith('Run the migration again', {
        preserveInput: true,
        attachments: lastUserMessage.attachments,
      });
      flushSync(() => button(container, 'Restart agent')?.click());
      expect(props.restartSession).toHaveBeenCalledTimes(1);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('hides Retry when there is no sent message and disables it while offline', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ChatContent {...errorProps({ messages: [] })} />));
      expect(button(container, 'Retry')).toBeUndefined();
      expect(button(container, 'Restart agent')).toBeDefined();
      flushSync(() => root.render(<ChatContent {...errorProps({ connected: false })} />));
      expect(button(container, 'Retry')?.disabled).toBe(true);
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('stays dismissed for the same error and returns after the error clears', () => {
    const props = errorProps();
    const container = document.createElement('div');
    const root = createRoot(container);
    const strip = () => container.querySelector('[data-testid="agent-error-strip"]');
    try {
      flushSync(() => root.render(<ChatContent {...props} />));
      flushSync(() => button(container, 'Dismiss error')?.click());
      expect(strip()).toBeNull();
      flushSync(() => root.render(<ChatContent {...props} inputDraft="typing" />));
      expect(strip()).toBeNull();
      flushSync(() =>
        root.render(
          <ChatContent
            {...props}
            sessionRuntime={{ ...props.sessionRuntime, errorMessage: 'Request timed out' }}
          />
        )
      );
      expect(strip()?.textContent).toContain('Request timed out');
      flushSync(() => button(container, 'Dismiss error')?.click());
      flushSync(() =>
        root.render(<ChatContent {...props} sessionRuntime={createInitialSessionRuntimeState()} />)
      );
      expect(strip()).toBeNull();
      flushSync(() =>
        root.render(
          <ChatContent
            {...props}
            sessionRuntime={{ ...props.sessionRuntime, errorMessage: 'Request timed out' }}
          />
        )
      );
      expect(strip()?.textContent).toContain('Request timed out');
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

describe('ChatContent message queue wording', () => {
  it.each([
    { promptInFlight: false, placeholder: 'Type a message…' },
    { promptInFlight: true, placeholder: 'Message will be queued…' },
    { promptInFlight: undefined, placeholder: 'Message will be queued…' },
  ])(
    'uses prompt ownership when promptInFlight=$promptInFlight',
    ({ promptInFlight, placeholder }) => {
      const props = {
        ...defaultScrollProps,
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        messages: [],
        queuedMessages: [],
        sessionStatus: { phase: 'running' },
        sessionRuntime: {
          ...createInitialSessionRuntimeState(),
          phase: 'running',
          activity: 'WORKING',
          processState: 'alive',
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
        chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
        pendingRequest: { type: 'none' },
        pendingMessages: new Map(),
        inputRef: createRef(),
      } as unknown as ChatContentProps;
      const root = createRoot(document.createElement('div'));
      try {
        flushSync(() => root.render(<ChatContent {...props} />));
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
});

describe('ChatContent pending request wording', () => {
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
        type: 'permission',
        request: { requestId: 'r-2', toolName: 'ExitPlanMode', toolInput: {} },
      },
      pendingRequestType: 'plan_approval',
      placeholder: 'Approve the plan or keep planning…',
    },
    {
      pendingRequest: {
        type: 'question',
        request: { requestId: 'r-3', toolName: 'AskUserQuestion', questions: [] },
      },
      pendingRequestType: 'user_question',
      placeholder: 'Answer the question above, or queue a message…',
    },
  ])('says the agent waits on a $pendingRequestType', (testCase) => {
    const props = {
      ...defaultScrollProps,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      messages: [],
      queuedMessages: [],
      sessionStatus: { phase: 'running' },
      sessionRuntime: {
        ...createInitialSessionRuntimeState(),
        phase: 'running',
        activity: 'WORKING',
        processState: 'alive',
      },
      chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
      pendingRequest: testCase.pendingRequest,
      pendingMessages: new Map(),
      inputRef: createRef(),
    } as unknown as ChatContentProps;
    const root = createRoot(document.createElement('div'));
    try {
      flushSync(() => root.render(<ChatContent {...props} />));
      expect(input.mock.lastCall?.[0].placeholder).toBe(testCase.placeholder);
      expect(transcript.mock.lastCall?.[0]).toMatchObject({
        pendingRequestType: testCase.pendingRequestType,
      });
      flushSync(() =>
        root.render(
          <ChatContent
            {...props}
            sessionRuntime={{ ...props.sessionRuntime, processState: 'stopped' }}
          />
        )
      );
      expect(transcript.mock.lastCall?.[0].pendingRequestType).toBeNull();
      expect(input.mock.lastCall?.[0].placeholder).not.toBe(testCase.placeholder);

      flushSync(() =>
        root.render(
          <ChatContent
            {...props}
            sessionRuntime={{ ...props.sessionRuntime, phase: 'stopping' }}
            sessionStatus={{ phase: 'stopping' }}
          />
        )
      );
      expect(transcript.mock.lastCall?.[0].pendingRequestType).toBeNull();
      flushSync(() =>
        root.render(
          <ChatContent
            {...props}
            sessionRuntime={{ ...props.sessionRuntime, phase: 'idle' }}
            sessionStatus={{ phase: 'ready' }}
          />
        )
      );
      expect(input.mock.lastCall?.[0].placeholder).toBe('Type a message to start the agent…');
      expect(transcript.mock.lastCall?.[0].pendingRequestType).toBeNull();
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

describe('ChatContent transcript ownership', () => {
  it.each(['starting', 'waiting', 'running'] as const)(
    'matches the running count when a sibling is %s',
    (siblingStatus) => {
      subagentState.siblingStatus = siblingStatus;
      const onOpenSubagent = vi.fn();
      const props = {
        ...defaultScrollProps,
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        onOpenSubagent,
        messages: [],
        queuedMessages: [],
        sessionStatus: { phase: 'ready' },
        sessionRuntime: createInitialSessionRuntimeState(),
        chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
        pendingRequest: { type: 'none' },
        pendingMessages: new Map(),
        inputRef: createRef(),
      } as unknown as ChatContentProps;
      const root = createRoot(document.createElement('div'));
      try {
        flushSync(() => root.render(<ChatContent {...props} />));
        const display = transcript.mock.lastCall?.[0];
        if (siblingStatus === 'running') {
          expect(display.onOpenSingleSubagent).toBeUndefined();
        } else {
          expect(display.onOpenSingleSubagent).toBeTypeOf('function');
          display.onOpenSingleSubagent();
          expect(onOpenSubagent).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              subagent: expect.objectContaining({ id: 'agent-1' }),
            })
          );
        }
      } finally {
        flushSync(() => root.unmount());
        subagentState.siblingStatus = 'completed';
      }
    }
  );
  it.each(['agent-1', 'agent-2'])('opens lifecycle target %s in its parent session', (id) => {
    const onOpenSubagent = vi.fn();
    const props = {
      ...defaultScrollProps,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      parentSessionName: 'Main chat',
      onOpenSubagent,
      messages: [],
      queuedMessages: [],
      sessionStatus: { phase: 'ready' },
      sessionRuntime: createInitialSessionRuntimeState(),
      chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
      pendingRequest: { type: 'none' },
      pendingMessages: new Map(),
      inputRef: createRef(),
    } as unknown as ChatContentProps;
    const root = createRoot(document.createElement('div'));
    try {
      flushSync(() => root.render(<ChatContent {...props} />));
      const display = transcript.mock.lastCall?.[0];
      expect(display.onOpenSubagent).toBeTypeOf('function');
      display.onOpenSubagent(id);
      expect(onOpenSubagent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          parentSessionId: 'session-1',
          parentSessionName: 'Main chat',
          subagent: expect.objectContaining({ id }),
        })
      );
      display.onOpenSubagent('missing');
      expect(onOpenSubagent).toHaveBeenCalledOnce();
      display.onOpenSingleSubagent();
      expect(onOpenSubagent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subagent: expect.objectContaining({ id: 'agent-1' }),
        })
      );
    } finally {
      flushSync(() => root.unmount());
    }
  });
  it('opens an active sub-agent transcript directly from the chat list', () => {
    const onOpenSubagent = vi.fn();
    const props = {
      ...defaultScrollProps,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      parentSessionName: 'Main chat',
      onOpenSubagent,
      messages: [],
      queuedMessages: [],
      sessionStatus: { phase: 'ready' },
      sessionRuntime: createInitialSessionRuntimeState(),
      chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
      pendingRequest: { type: 'none' },
      pendingMessages: new Map(),
      inputRef: createRef(),
    } as unknown as ChatContentProps;
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() => root.render(<ChatContent {...props} />));
      const list = transcript.mock.lastCall?.[0].runningSubagentList;
      flushSync(() => root.render(list));
      expect(container.textContent).toContain('Review code');
      expect(container.textContent).not.toContain('Finished task');
      container.querySelector<HTMLButtonElement>('li button')?.click();
      expect(onOpenSubagent).toHaveBeenCalledWith(
        expect.objectContaining({
          parentSessionId: 'session-1',
          parentSessionName: 'Main chat',
          subagent: expect.objectContaining({ id: 'agent-1' }),
        })
      );
    } finally {
      flushSync(() => root.unmount());
    }
  });

  it('delegates its scroll lifecycle to the shared transcript', () => {
    const transcriptScroll = {
      identity: 'workspace-1/main/session-1',
      active: true,
      ready: true,
      initialIntent: 'following',
      initialPosition: null,
    };
    const props = {
      ...defaultScrollProps,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      messages: [],
      queuedMessages: [],
      sessionStatus: { phase: 'ready' },
      sessionRuntime: createInitialSessionRuntimeState(),
      chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
      pendingRequest: { type: 'none' },
      pendingMessages: new Map(),
      inputRef: createRef(),
      transcriptScroll,
    } as unknown as ChatContentProps;
    const root = createRoot(document.createElement('div'));
    try {
      flushSync(() => root.render(<ChatContent {...props} />));
      expect(transcript).toHaveBeenLastCalledWith(
        expect.objectContaining({ scroll: transcriptScroll })
      );
    } finally {
      flushSync(() => root.unmount());
    }
  });
});

vi.mock('@/client/features/subagents', async () => {
  const subagents = [
    {
      id: 'agent-1',
      name: 'Review code',
      status: 'running',
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      latestActivity: null,
      resultPreview: null,
    },
    {
      id: 'agent-2',
      name: 'Finished task',
      status: 'completed',
      createdAt: null,
      updatedAt: null,
      completedAt: null,
      latestActivity: null,
      resultPreview: null,
    },
  ];
  return {
    SubagentList: (
      await vi.importActual<typeof import('@/client/features/subagents/subagent-list')>(
        '@/client/features/subagents/subagent-list'
      )
    ).SubagentList,
    useSubagentTimelineMessages: (messages: unknown[]) => {
      const currentSubagents = subagents.map((agent) =>
        agent.id === 'agent-2' ? { ...agent, status: subagentState.siblingStatus } : agent
      );
      return {
        messages,
        subagents: currentSubagents,
        error: null,
        subagentListState: { kind: 'ready', subagents: currentSubagents },
      };
    },
  };
});
