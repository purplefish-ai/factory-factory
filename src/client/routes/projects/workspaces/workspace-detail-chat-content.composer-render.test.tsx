// @vitest-environment jsdom
import { createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  type ChatMessage,
  createEmptyTokenStats,
  DEFAULT_CHAT_SETTINGS,
} from '@/lib/chat-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { createInitialSessionRuntimeState } from '@/shared/session-runtime';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';

// Render probes for the real composer and its memoized children. Each probe is
// rendered (or called) exactly once per render of the component that owns it.
const probes = vi.hoisted(() => ({
  chatInput: vi.fn(),
  leftControls: vi.fn(),
  runtimeOptions: vi.fn(),
  usageControl: vi.fn(),
  voiceToggle: vi.fn((_props: { running: boolean; disabled: boolean }) => null),
}));

// The real memoized ChatInput; the transcript is out of scope here.
vi.mock('@/client/features/chat', async () => ({
  useTranscriptSend: (
    await vi.importActual<typeof import('@/client/features/chat/use-transcript-send')>(
      '@/client/features/chat/use-transcript-send'
    )
  ).useTranscriptSend,
  getChatPendingRequestType: (
    await vi.importActual<typeof import('@/client/features/chat/pending-request-type')>(
      '@/client/features/chat/pending-request-type'
    )
  ).getChatPendingRequestType,
  ChatInput: (
    await vi.importActual<typeof import('@/client/features/chat/chat-input/chat-input')>(
      '@/client/features/chat/chat-input/chat-input'
    )
  ).ChatInput,
  useGroupedChatMessages: (messages: unknown[]) => messages,
  AgentErrorStrip: () => null,
  ChatTranscript: () => null,
  PermissionPrompt: () => null,
  QuestionPrompt: () => null,
}));
// ChatInput calls this hook once per render.
vi.mock('@/client/features/chat/chat-input/hooks/use-textarea-resize', () => ({
  useTextareaResize: () => probes.chatInput(),
}));
// LeftControls renders the model picker once per render.
vi.mock('@/client/features/session-selection', () => ({
  ProviderModelPicker: () => {
    probes.leftControls();
    return null;
  },
}));
// RuntimeOptions renders the thinking toggle once per render.
vi.mock('@/client/features/chat/chat-input/components/settings-toggle', () => ({
  SettingsToggle: () => {
    probes.runtimeOptions();
    return null;
  },
}));
// RightControls' children.
vi.mock('@/client/features/chat/usage-stats/provider-usage-control', () => ({
  ProviderUsageControl: () => {
    probes.usageControl();
    return null;
  },
}));
vi.mock('@/client/features/composer', () => ({
  FileMentionPalette: () => null,
  SlashCommandPalette: () => null,
  usePasteDropHandler: () => ({}),
  useSlashCommands: () => ({}),
}));
vi.mock('@/client/features/chat/chat-input/hooks/use-file-mentions', () => ({
  useFileMentions: () => ({}),
}));
vi.mock('@/client/features/voice', () => ({ VoiceModeToggle: probes.voiceToggle }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      listQuickActions: {
        useQuery: () => ({ data: [], isPending: false, isError: false, refetch: vi.fn() }),
      },
    },
  },
}));
vi.mock('./use-retry-workspace-init', () => ({
  useRetryWorkspaceInit: () => ({ retry: () => undefined, retryInit: { isPending: false } }),
}));
vi.mock('@/client/features/subagents', () => ({
  SubagentList: () => null,
  useSubagentTimelineMessages: (messages: unknown[]) => ({
    messages,
    error: null,
    runningSubagentIconIndices: [],
    subagents: [],
    subagentListState: { kind: 'loading' },
  }),
}));

const capabilities: ChatBarCapabilities = {
  provider: 'CLAUDE',
  model: {
    enabled: true,
    options: [
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
    ],
    selected: 'sonnet',
  },
  reasoning: { enabled: false, options: [] },
  thinking: { enabled: true },
  planMode: { enabled: false },
  attachments: { enabled: false, kinds: [] },
  slashCommands: { enabled: false },
  usageStats: { enabled: true, contextWindow: true },
  rewind: { enabled: false },
};

function assistantMessage(id: string, text: string): ChatMessage {
  return { id, source: 'agent', text, timestamp: '2026-01-01T00:00:00.000Z', order: 0 };
}

const sessionRuntime = {
  ...createInitialSessionRuntimeState(),
  phase: 'running',
  activity: 'WORKING',
  processState: 'alive',
  work: { promptInFlight: true, backgroundTasks: [], runningSubagents: 0, activeGoals: 0 },
} as ChatContentProps['sessionRuntime'];
const noop = () => undefined;
// Every prop here is a stable reference, as the chat reducer provides them.
const baseProps = {
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  messages: [assistantMessage('m1', 'Hel')],
  queuedMessages: [],
  sessionStatus: { phase: 'running' },
  sessionRuntime,
  connected: true,
  chatSettings: DEFAULT_CHAT_SETTINGS,
  chatCapabilities: capabilities,
  chatCapabilitiesLoaded: true,
  pendingRequest: { type: 'none' },
  pendingMessages: new Map(),
  inputRef: createRef(),
  transcriptScroll: {
    identity: 'workspace-1/main/session-1',
    active: true,
    ready: false,
    initialIntent: 'following',
    initialPosition: null,
  },
  sendMessage: noop,
  stopChat: noop,
  updateSettings: noop,
  setInputDraft: noop,
  setInputAttachments: noop,
  setConfigOption: noop,
  inputDraft: '',
  inputAttachments: [],
  slashCommands: [],
  slashCommandsLoaded: true,
  tokenStats: createEmptyTokenStats(),
  acpConfigOptions: null,
  initBanner: null,
  isScriptFailed: false,
} as unknown as ChatContentProps;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
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

function renderCounts() {
  return {
    chatInput: probes.chatInput.mock.calls.length,
    leftControls: probes.leftControls.mock.calls.length,
    runtimeOptions: probes.runtimeOptions.mock.calls.length,
    usageControl: probes.usageControl.mock.calls.length,
    voiceToggle: probes.voiceToggle.mock.calls.length,
  };
}

it('does not re-render the composer while a session streams', () => {
  render();
  const initial = renderCounts();
  expect(initial).toEqual({
    chatInput: 1,
    leftControls: 1,
    runtimeOptions: 1,
    usageControl: 1,
    voiceToggle: 1,
  });

  // Each streaming delta replaces the transcript and the latest thinking text.
  let text = 'Hel';
  for (const chunk of ['lo', ', ', 'wor', 'ld', '!']) {
    text += chunk;
    render({ messages: [assistantMessage('m1', text)], latestThinking: text });
  }

  expect(renderCounts()).toEqual(initial);
});

it('keeps the composer controls memoized when only usage changes', () => {
  render();
  const before = renderCounts();

  render({ tokenStats: { ...createEmptyTokenStats(), inputTokens: 1200 } });

  expect(renderCounts()).toEqual({
    ...before,
    chatInput: before.chatInput + 1,
    usageControl: before.usageControl + 1,
  });
});

it('keeps the runtime options memoized when only the quick-action menu changes', () => {
  render({ newChatUnavailableReason: null });
  const before = renderCounts();

  render({ newChatUnavailableReason: 'Another chat is starting' });

  expect(renderCounts()).toEqual({
    ...before,
    chatInput: before.chatInput + 1,
    leftControls: before.leftControls + 1,
  });
});

it('still re-renders the composer when its inputs change', () => {
  render();
  expect(probes.voiceToggle.mock.lastCall?.[0]).toMatchObject({ running: true, disabled: false });
  const before = renderCounts();

  render({ sessionStatus: { phase: 'ready' } as ChatContentProps['sessionStatus'] });

  expect(probes.voiceToggle.mock.lastCall?.[0]).toMatchObject({ running: false, disabled: false });
  const after = renderCounts();
  expect(after.chatInput).toBeGreaterThan(before.chatInput);
  expect(after.voiceToggle).toBeGreaterThan(before.voiceToggle);
});
