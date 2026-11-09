// @vitest-environment jsdom
import { createRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SubagentListItem } from '@/client/features/subagents';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';

const spies = vi.hoisted(() => ({
  rows: vi.fn(),
  scroll: vi.fn(),
  input: vi.fn((_props: { value: string }) => null),
  retry: () => undefined,
}));
const timeline = vi.hoisted(() => ({
  current: {
    messages: [] as unknown[],
    error: null,
    runningSubagentIconIndices: [] as number[],
    subagents: [] as unknown[],
    subagentListState: { kind: 'loading' } as unknown,
  },
}));

// The real memoized transcript, with render probes on its instance and rows.
vi.mock('@/client/features/chat', async () => ({
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
  ChatTranscript: (
    await vi.importActual<typeof import('@/client/features/chat/chat-transcript')>(
      '@/client/features/chat/chat-transcript'
    )
  ).ChatTranscript,
  getChatPendingRequestType: (
    await vi.importActual<typeof import('@/client/features/chat/pending-request-type')>(
      '@/client/features/chat/pending-request-type'
    )
  ).getChatPendingRequestType,
  useGroupedChatMessages: (messages: unknown[]) => messages,
  ChatInput: spies.input,
  PermissionPrompt: () => null,
  QuestionPrompt: () => null,
}));
vi.mock('@/client/features/chat/transcript-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/client/features/chat/transcript-rows')>();
  return {
    TranscriptRows: (props: Parameters<typeof actual.TranscriptRows>[0]) => {
      spies.rows();
      return actual.TranscriptRows(props);
    },
  };
});
vi.mock('@/client/features/chat/use-transcript-scroll', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/client/features/chat/use-transcript-scroll')>();
  return {
    useTranscriptScroll: (...args: Parameters<typeof actual.useTranscriptScroll>) => {
      spies.scroll();
      return actual.useTranscriptScroll(...args);
    },
  };
});
// Render the running sub-agent list inline instead of inside a closed collapsible.
vi.mock('@/client/features/chat/session-activity-indicator', () => ({
  SessionActivityIndicator: ({ runningSubagentList }: { runningSubagentList?: ReactNode }) => (
    <div data-testid="activity">{runningSubagentList}</div>
  ),
}));
vi.mock('@/client/features/voice', () => ({ VoiceModeToggle: () => null }));
vi.mock('./use-retry-workspace-init', () => ({
  useRetryWorkspaceInit: () => ({ retry: spies.retry, retryInit: { isPending: false } }),
}));
vi.mock('@/client/features/subagents', async () => ({
  SubagentList: (
    await vi.importActual<typeof import('@/client/features/subagents/subagent-list')>(
      '@/client/features/subagents/subagent-list'
    )
  ).SubagentList,
  // Like the real hook: a new result object whose fields keep their identity.
  useSubagentTimelineMessages: () => ({ ...timeline.current }),
}));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {
      /* jsdom has no layout. */
    }
    disconnect() {
      /* jsdom has no layout. */
    }
  }
);

function subagent(id: string, name: string): SubagentListItem {
  return {
    id,
    name,
    status: 'running',
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    latestActivity: null,
    resultPreview: null,
  };
}

function setSubagents(subagents: SubagentListItem[]) {
  timeline.current = {
    ...timeline.current,
    subagents,
    subagentListState: { kind: 'ready', subagents },
  };
}

function banner(message: string): WorkspaceInitBanner {
  return { kind: 'warning', message, showRetry: true, showPlay: false, showDismiss: true };
}

const MESSAGES: ChatContentProps['messages'] = [];
const QUEUED: ChatContentProps['queuedMessages'] = [];
const sessionRuntime = {
  ...createInitialSessionRuntimeState(),
  phase: 'running',
  activity: 'WORKING',
  processState: 'alive',
  work: { promptInFlight: true, backgroundTasks: [], runningSubagents: 2, activeGoals: 0 },
} as ChatContentProps['sessionRuntime'];
const baseProps = {
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  parentSessionName: 'Main chat',
  onOpenSubagent: () => undefined,
  messages: MESSAGES,
  queuedMessages: QUEUED,
  sessionStatus: { phase: 'running' },
  sessionRuntime,
  connected: true,
  chatCapabilities: EMPTY_CHAT_BAR_CAPABILITIES,
  pendingRequest: { type: 'none' },
  pendingMessages: new Map(),
  inputRef: createRef(),
  // Not ready keeps every transcript row in the DOM; jsdom cannot virtualize.
  transcriptScroll: {
    identity: 'workspace-1/main/session-1',
    active: true,
    ready: false,
    initialIntent: 'following',
    initialPosition: null,
  },
  initBanner: banner('Setup warning A'),
  isScriptFailed: false,
  inputDraft: '',
} as unknown as ChatContentProps;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  setSubagents([subagent('agent-1', 'Review code'), subagent('agent-2', 'Write tests')]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(overrides: Partial<ChatContentProps> = {}) {
  flushSync(() => root.render(<ChatContent {...baseProps} {...overrides} />));
}

it('does not re-render the transcript while typing in the composer', () => {
  render();
  expect(container.textContent).toContain('Setup warning A');
  expect(container.querySelector('[data-testid="activity"]')?.textContent).toContain('Review code');
  const rowRenders = spies.rows.mock.calls.length;
  const transcriptRenders = spies.scroll.mock.calls.length;
  expect(rowRenders).toBeGreaterThan(0);

  for (const draft of ['h', 'he', 'hel', 'hell', 'hello']) {
    render({ inputDraft: draft });
  }

  expect(spies.input.mock.lastCall?.[0].value).toBe('hello');
  expect(spies.scroll).toHaveBeenCalledTimes(transcriptRenders);
  expect(spies.rows).toHaveBeenCalledTimes(rowRenders);
});

it('still updates the running sub-agent list and header when their inputs change', () => {
  render({ inputDraft: 'draft' });
  const rowRenders = spies.rows.mock.calls.length;

  // The memoized ChatContent only re-renders for a prop change; in the app the
  // subagent query re-renders it from inside the hook.
  setSubagents([subagent('agent-1', 'Review code'), subagent('agent-3', 'Update docs')]);
  render({ inputDraft: 'draft!' });
  const activity = container.querySelector('[data-testid="activity"]');
  expect(activity?.textContent).toContain('Update docs');
  expect(activity?.textContent).not.toContain('Write tests');
  expect(spies.rows.mock.calls.length).toBeGreaterThan(rowRenders);

  render({ inputDraft: 'draft', initBanner: banner('Setup warning B') });
  expect(container.textContent).toContain('Setup warning B');
  expect(container.textContent).not.toContain('Setup warning A');

  render({
    inputDraft: 'draft',
    sessionRuntime: { ...sessionRuntime, phase: 'error', errorMessage: 'Request timed out' },
  });
  expect(container.textContent).toContain('Request timed out');
});
