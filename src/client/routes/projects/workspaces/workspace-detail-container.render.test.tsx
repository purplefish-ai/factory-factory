// @vitest-environment jsdom

import { act, createElement, type ReactNode, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MainViewTab } from '@/client/features/workspace';

// Render counters for the real container and view. Each mocked component or
// hook below is called once per render of the component that owns it.
const probes = vi.hoisted(() => ({
  container: vi.fn(),
  header: vi.fn((_props: { running: boolean }) => null),
  tabBar: vi.fn((_props: { sessionSummariesById: ReadonlyMap<string, unknown> }) => null),
  rightPanel: vi.fn(),
  chat: vi.fn((_props: { messages: unknown[] }) => null),
}));

// A chat hook driven by an external stream, so a streamed event re-renders
// only the component that calls the hook.
const stream = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const initial = {
    messages: [] as { id: string }[],
    latestThinking: null as string | null,
    queuedMessages: [],
    connected: true,
    controlsHydrated: true,
    pendingRequest: { type: 'none' },
    chatSettings: {},
    chatCapabilities: { attachments: { enabled: true, kinds: ['image'] } },
    sessionStatus: { phase: 'ready' },
    processStatus: { state: 'alive' },
    sessionRuntime: {
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: '2026-11-10T12:00:00Z',
    },
    runtimeSessionId: 'session-a',
    pendingMessages: new Map(),
    inputDraft: '',
    inputAttachments: [],
    inputDraftGeneration: 0,
    isRestartingSession: false,
    inputRef: { current: null },
    restartSession: () => undefined,
    resumeQueuedMessages: () => undefined,
  };
  let snapshot = initial;
  return {
    reset: () => {
      snapshot = initial;
    },
    get: () => snapshot,
    update: (patch: Partial<typeof initial>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

function useStreamedChatWebSocket() {
  return useSyncExternalStore(stream.subscribe, stream.get);
}

const panel = vi.hoisted(() => ({
  activeTabId: 'chat',
  rightPanelVisible: true,
  tabs: [] as MainViewTab[],
  setRightPanelVisible: () => undefined,
  setActiveBottomTab: () => undefined,
  selectTab: () => undefined,
  openTab: () => undefined,
  openSubagentTab: () => undefined,
}));
const persistence = vi.hoisted(() => ({
  ready: true,
  initialPosition: null,
  onPositionChange: () => undefined,
  clearSession: () => undefined,
}));
const sessionManagement = vi.hoisted(() => ({
  createSession: { isPending: false },
  deleteSession: { isPending: false },
  archiveWorkspace: { isPending: false, mutate: () => undefined },
  openInIde: { isPending: false, mutate: () => undefined },
  availableIdes: [],
  preferredIde: 'cursor',
  handleSelectSession: () => undefined,
  handleCloseSession: () => undefined,
  handleNewChat: () => undefined,
  handleQuickAction: async () => undefined,
}));
const selection = vi.hoisted(() => ({
  selectedDbSessionId: 'session-a',
  setSelectedDbSessionId: () => undefined,
}));
const utils = vi.hoisted(() => ({}));
const childWorkspaces = vi.hoisted(() => ({ data: [] }));
const initStatus = vi.hoisted(() => ({
  workspaceInitStatus: null,
  isScriptFailed: false,
  setupWarningDismissed: false,
  dismissSetupWarning: () => undefined,
}));
const workspaceData = vi.hoisted(() => ({
  workspace: { id: 'workspace-one', creationSource: 'MANUAL', worktreePath: '/workspace' },
  workspaceLoading: false,
  workspaceError: null,
  isFetchingWorkspace: false,
  refetchWorkspace: () => undefined,
  sessions: ['session-a', 'session-b'].map((id) => ({
    id,
    name: id,
    workflow: null,
    model: null,
    status: 'RUNNING',
  })),
  initialDbSessionId: 'session-a',
  maxSessions: 5,
}));

const router = vi.hoisted(() => ({
  params: { slug: 'project', id: 'workspace-one' },
  navigate: () => undefined,
  searchParams: [new URLSearchParams(), () => undefined] as const,
  location: { key: 'navigation' },
}));
vi.mock('react-router', () => ({
  useParams: () => router.params,
  useNavigate: () => router.navigate,
  useSearchParams: () => router.searchParams,
  useLocation: () => router.location,
}));
vi.mock('@/client/features/chat/use-chat-websocket', () => ({
  useChatWebSocket: useStreamedChatWebSocket,
}));
vi.mock('@/client/features/workspace', () => ({
  useWorkspacePanel: () => panel,
  useChatTranscriptPersistence: () => persistence,
  ArchiveGitLockDialog: () => null,
  ArchiveWorkspaceDialog: () => null,
}));
vi.mock('@/client/features/workspace/right-panel', () => ({
  RightPanel: () => {
    probes.rightPanel();
    return null;
  },
}));
vi.mock('@/client/features/workspace/workspace-content-view', () => ({
  // Owns the session tab bar and passes the chat through as children.
  WorkspaceContentView: (props: {
    children: ReactNode;
    sessionSummariesById: ReadonlyMap<string, unknown>;
  }) => {
    probes.tabBar(props);
    return createElement('main', null, props.children);
  },
}));
vi.mock('@/client/components/image-drop-zone', () => ({
  ImageDropZone: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/hooks/use-workspace-drawer', () => ({ useWorkspaceDrawer: () => false }));
vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => null,
  ResizablePanel: ({ children }: { children: ReactNode }) => children,
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./workspace-side-panel', () => ({
  WorkspaceSidePanel: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => utils,
    workspace: { listChildren: { useQuery: () => childWorkspaces } },
  },
}));
vi.mock('@/client/routes/projects/workspaces/workspace-detail-header', () => ({
  WorkspaceDetailHeaderSlot: probes.header,
}));
vi.mock('./use-workspace-detail', () => ({
  useWorkspaceData: () => {
    probes.container();
    return workspaceData;
  },
  useSessionManagement: () => sessionManagement,
}));
vi.mock('./use-workspace-detail-hooks', () => ({
  useSelectedSessionId: () => selection,
  useWorkspaceInitStatus: () => initStatus,
  useWorkspaceHasChanges: () => false,
  useArchivedWorkspaceRedirect: () => undefined,
  useAutoFocusChatInput: () => undefined,
}));
vi.mock('./workspace-detail-chat-content', () => ({ ChatContent: probes.chat }));

import { WorkspaceDetailContainer } from './workspace-detail-container';

let root: Root;
let host: HTMLDivElement;

function renderCounts() {
  return {
    container: probes.container.mock.calls.length,
    header: probes.header.mock.calls.length,
    tabBar: probes.tabBar.mock.calls.length,
    rightPanel: probes.rightPanel.mock.calls.length,
    chat: probes.chat.mock.calls.length,
  };
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  stream.reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root.render(createElement(WorkspaceDetailContainer)));
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('renders only the chat for a streamed event, not the container, header, tab bar or panel', async () => {
  const before = renderCounts();
  await act(() =>
    stream.update({
      messages: [...stream.get().messages, { id: 'streamed' }],
      latestThinking: 'Thinking about it',
    })
  );
  const after = renderCounts();

  expect(after.chat).toBe(before.chat + 1);
  expect(probes.chat.mock.lastCall?.[0].messages).toEqual([{ id: 'streamed' }]);
  expect(after.container).toBe(before.container);
  expect(after.header).toBe(before.header);
  expect(after.tabBar).toBe(before.tabBar);
  expect(after.rightPanel).toBe(before.rightPanel);
});

it('updates the header and tab bar when the selected session starts working', async () => {
  expect(probes.header.mock.lastCall?.[0].running).toBe(false);
  await act(() =>
    stream.update({
      sessionStatus: { phase: 'running' },
      sessionRuntime: {
        phase: 'running',
        processState: 'alive',
        activity: 'WORKING',
        updatedAt: '2026-11-10T12:00:01Z',
      },
    })
  );
  expect(probes.header.mock.lastCall?.[0].running).toBe(true);
  expect(probes.tabBar.mock.lastCall?.[0].sessionSummariesById.get('session-a')).toMatchObject({
    runtimePhase: 'running',
    activity: 'WORKING',
  });
});
