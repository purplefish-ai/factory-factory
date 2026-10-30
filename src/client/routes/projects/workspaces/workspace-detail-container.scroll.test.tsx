// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainViewTab } from '@/client/features/workspace';
import type { ChatContentProps } from './workspace-detail-chat-content';
import type { WorkspaceDetailViewProps } from './workspace-detail-view';

const mocks = vi.hoisted(() => ({
  workspaceId: 'workspace-one',
  selectedSessionId: 'session-a' as string | null,
  passiveTransportSessionId: null as string | null,
  transport: {
    messages: [],
    connected: true,
    sessionStatus: { phase: 'ready' },
    processStatus: { state: 'alive' },
    sessionRuntime: {
      phase: 'idle',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: '2026-10-30T12:00:00Z',
    },
    runtimeSessionId: 'session-a' as string | null,
    inputRef: { current: null },
  },
  persistence: {
    ready: true,
    initialPosition: {
      intent: 'reading' as const,
      top: 160,
      left: 0,
      anchor: { key: 'row-a', offset: 7 },
    },
    onPositionChange: vi.fn(),
    clearSession: vi.fn(),
  },
  panel: {
    activeTabId: 'chat',
    rightPanelVisible: false,
    tabs: [] as MainViewTab[],
    setRightPanelVisible: vi.fn(),
    setActiveTopTab: vi.fn(),
    selectTab: vi.fn(),
    openTab: vi.fn(),
    openSubagentTab: vi.fn(),
  },
  useChatWebSocket: vi.fn(),
  usePersistence: vi.fn(),
  navigate: vi.fn(),
  setSearchParams: vi.fn(),
  selectSession: vi.fn(),
  closeSession: vi.fn(),
  mutate: vi.fn(),
  utils: {},
  searchParams: new URLSearchParams(),
}));

function useMockChatWebSocket({ dbSessionId }: { dbSessionId: string | null }) {
  // A selected-session render precedes the transport's passive identity cleanup.
  useEffect(() => {
    mocks.passiveTransportSessionId = dbSessionId;
  }, [dbSessionId]);
  return mocks.transport;
}

// The view receives layout props; chat props reach ChatContent through context.
// Each capture pairs both from one container render.
type CapturedProps = WorkspaceDetailViewProps & { chat: ChatContentProps };
const captures: { props: CapturedProps; passiveTransportSessionId: string | null }[] = [];
let lastViewProps: WorkspaceDetailViewProps | undefined;

vi.mock('react-router', () => ({
  useParams: () => ({ slug: 'project', id: mocks.workspaceId }),
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [mocks.searchParams, mocks.setSearchParams],
  useLocation: () => ({ key: 'navigation' }),
}));
vi.mock('@/client/features/chat', () => ({ useChatWebSocket: mocks.useChatWebSocket }));
vi.mock('@/client/features/workspace', () => ({
  useWorkspacePanel: () => mocks.panel,
  useChatTranscriptPersistence: mocks.usePersistence,
  ArchiveGitLockDialog: () => null,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => mocks.utils,
    workspace: { listChildren: { useQuery: () => ({ data: [] }) } },
  },
}));
vi.mock('@/client/routes/projects/workspaces/workspace-detail-header', () => ({
  WorkspaceDetailHeaderSlot: () => null,
}));
vi.mock('./use-workspace-detail', () => ({
  useWorkspaceData: () => ({
    workspace: { id: mocks.workspaceId, creationSource: 'MANUAL', worktreePath: '/workspace' },
    workspaceLoading: false,
    sessions: ['session-a', 'session-b'].map((id) => ({
      id,
      name: id,
      workflow: null,
      model: null,
      status: 'RUNNING',
    })),
    initialDbSessionId: 'session-a',
    maxSessions: 5,
  }),
  useSessionManagement: () => ({
    createSession: { isPending: false },
    deleteSession: { isPending: false },
    archiveWorkspace: { isPending: false, mutate: mocks.mutate },
    openInIde: { isPending: false, mutate: mocks.mutate },
    availableIdes: [],
    preferredIde: 'cursor',
    handleSelectSession: mocks.selectSession,
    handleCloseSession: mocks.closeSession,
    handleNewChat: vi.fn(),
    handleQuickAction: vi.fn(),
  }),
}));
vi.mock('./use-workspace-detail-hooks', () => ({
  useSelectedSessionId: () => ({
    selectedDbSessionId: mocks.selectedSessionId,
    setSelectedDbSessionId: mocks.selectSession,
  }),
  useWorkspaceInitStatus: () => ({
    workspaceInitStatus: null,
    isScriptFailed: false,
    setupWarningDismissed: false,
    dismissSetupWarning: vi.fn(),
  }),
  useWorkspaceHasChanges: () => false,
  useArchivedWorkspaceRedirect: () => undefined,
  useAutoFocusChatInput: () => undefined,
}));
vi.mock('./workspace-detail-view', () => ({
  WorkspaceDetailView: (props: WorkspaceDetailViewProps) => {
    lastViewProps = props;
    return CONNECTED_CHAT_CONTENT;
  },
}));
vi.mock('./workspace-detail-chat-content', () => ({
  ChatContent: (chat: ChatContentProps) => {
    if (!lastViewProps) {
      throw new Error('Expected the view to render before its chat content');
    }
    captures.push({
      props: { ...lastViewProps, chat },
      passiveTransportSessionId: mocks.passiveTransportSessionId,
    });
    return null;
  },
}));

import { CONNECTED_CHAT_CONTENT } from './workspace-chat-slot';
import { WorkspaceDetailContainer } from './workspace-detail-container';

let root: Root;
let container: HTMLDivElement;
function latest() {
  const captured = captures.at(-1);
  if (!captured) {
    throw new Error('Expected the real container to render its view');
  }
  return captured.props;
}
async function render() {
  await act(() => root.render(<WorkspaceDetailContainer />));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  captures.length = 0;
  lastViewProps = undefined;
  mocks.workspaceId = 'workspace-one';
  mocks.selectedSessionId = 'session-a';
  mocks.passiveTransportSessionId = null;
  mocks.transport.runtimeSessionId = 'session-a';
  mocks.transport.connected = true;
  mocks.transport.sessionStatus.phase = 'ready';
  mocks.transport.sessionRuntime.phase = 'idle';
  mocks.persistence.ready = true;
  mocks.panel.activeTabId = 'chat';
  mocks.panel.rightPanelVisible = false;
  mocks.panel.tabs = [
    { id: 'chat', type: 'chat', label: 'Chat' },
    { id: 'file-a', type: 'file', path: 'a.ts', label: 'a.ts' },
    { id: 'diff-a', type: 'diff', path: 'a.ts', label: 'a.ts changes' },
    { id: 'subagent-a', type: 'subagent', label: 'Child agent' },
  ];
  mocks.useChatWebSocket.mockImplementation(useMockChatWebSocket);
  mocks.usePersistence.mockImplementation(() => mocks.persistence);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('WorkspaceDetailContainer transcript composition', () => {
  it.each([
    ['chat', true],
    ['file-a', false],
    ['diff-a', false],
    ['subagent-a', false],
    ['missing-tab', true],
  ] as const)('sets viewport activity for selected tab %s', async (tabId, active) => {
    mocks.panel.activeTabId = tabId;
    await render();
    expect(latest().chat.transcriptScroll.active).toBe(active);
    expect(latest().chat.transcriptScroll.ready).toBe(true);
  });

  it('keeps chat active when the right panel opens over it', async () => {
    mocks.panel.rightPanelVisible = true;
    await render();
    expect(latest().rightPanelVisible).toBe(true);
    expect(latest().chat.transcriptScroll.active).toBe(true);
  });

  it('suspends and resumes the same mounted transcript as the visible pane changes', async () => {
    await render();
    expect(latest().chat.transcriptScroll.active).toBe(true);
    for (const tabId of ['file-a', 'diff-a', 'subagent-a']) {
      mocks.panel.activeTabId = tabId;
      await render();
      expect(latest().chat.transcriptScroll.active).toBe(false);
      expect(latest().chat.transcriptScroll.identity).toBe('workspace-one/main/session-a');
    }
    mocks.panel.activeTabId = 'removed-tab';
    await render();
    expect(latest().chat.transcriptScroll.active).toBe(true);
    mocks.panel.activeTabId = 'chat';
    await render();
    expect(latest().chat.transcriptScroll.active).toBe(true);
  });

  it('passes the persistence snapshot and committed callback to the transcript', async () => {
    await render();
    expect(mocks.usePersistence).toHaveBeenCalledWith({
      workspaceId: 'workspace-one',
      sessionId: 'session-a',
    });
    expect(mocks.useChatWebSocket).toHaveBeenCalledWith({ dbSessionId: 'session-a' });
    expect(latest().chat.transcriptScroll).toMatchObject({
      identity: 'workspace-one/main/session-a',
      initialIntent: 'following',
      active: true,
      ready: true,
    });
    expect(latest().chat.transcriptScroll.initialPosition).toBe(mocks.persistence.initialPosition);
    expect(latest().chat.transcriptScroll.onPositionChange).toBe(
      mocks.persistence.onPositionChange
    );
  });

  it('waits for persistence even when the selected runtime has already hydrated', async () => {
    mocks.persistence.ready = false;
    await render();
    expect(latest().chat.transcriptScroll.ready).toBe(false);
    mocks.persistence.ready = true;
    await render();
    expect(latest().chat.transcriptScroll.ready).toBe(true);
  });

  it('does not activate readiness for null selection even when both identity markers are null', async () => {
    mocks.selectedSessionId = null;
    mocks.transport.runtimeSessionId = null;
    await render();
    expect(latest().chat.sessionId).toBeNull();
    expect(latest().chat.transcriptScroll.ready).toBe(false);
    expect(latest().chat.transcriptScroll.identity).toBe('workspace-one/main/none');
  });

  it('rejects the previous session snapshot on the selection render before transport passive cleanup', async () => {
    await render();
    expect(latest().chat.transcriptScroll.ready).toBe(true);
    captures.length = 0;
    mocks.selectedSessionId = 'session-b';
    await render();
    const selectionRender = captures[0];
    expect(selectionRender?.passiveTransportSessionId).toBe('session-a');
    expect(selectionRender?.props.chat.sessionId).toBe('session-b');
    expect(selectionRender?.props.chat.transcriptScroll.identity).toBe(
      'workspace-one/main/session-b'
    );
    expect(selectionRender?.props.chat.transcriptScroll.ready).toBe(false);
    expect(mocks.useChatWebSocket).toHaveBeenLastCalledWith({ dbSessionId: 'session-b' });
    mocks.transport.runtimeSessionId = 'session-b';
    await render();
    expect(latest().chat.transcriptScroll.ready).toBe(true);
  });

  it.each([
    { event: 'timeout before hydration', connected: true, phase: 'idle', runtimeSessionId: null },
    {
      event: 'disconnect before hydration',
      connected: false,
      phase: 'idle',
      runtimeSessionId: null,
    },
    {
      event: 'early running event before hydration',
      connected: true,
      phase: 'running',
      runtimeSessionId: null,
    },
    {
      event: 'early running event for an old snapshot',
      connected: true,
      phase: 'running',
      runtimeSessionId: 'session-b',
    },
  ])('keeps readiness suspended after $event', async ({ connected, phase, runtimeSessionId }) => {
    mocks.transport.sessionStatus.phase = 'loading';
    mocks.transport.sessionRuntime.phase = 'loading';
    mocks.transport.runtimeSessionId = null;
    await render();
    expect(latest().chat.transcriptScroll.ready).toBe(false);
    mocks.transport.connected = connected;
    mocks.transport.sessionStatus.phase = 'ready';
    mocks.transport.sessionRuntime.phase = phase;
    mocks.transport.runtimeSessionId = runtimeSessionId;
    await render();
    expect(latest().chat.sessionStatus.phase).toBe('ready');
    expect(latest().chat.sessionRuntime.phase).toBe(phase);
    expect(latest().chat.transcriptScroll.ready).toBe(false);
    mocks.transport.runtimeSessionId = 'session-a';
    await render();
    expect(latest().chat.transcriptScroll.ready).toBe(true);
  });

  it('retains hydrated readiness through a disconnect when the snapshot identity remains valid', async () => {
    await render();
    expect(latest().chat.transcriptScroll.ready).toBe(true);
    mocks.transport.connected = false;
    await render();
    expect(latest().chat.connected).toBe(false);
    expect(latest().chat.transcriptScroll.ready).toBe(true);
  });

  it('updates transcript identity on workspace changes and waits for the new persistence snapshot', async () => {
    await render();
    mocks.workspaceId = 'workspace-two';
    mocks.persistence.ready = false;
    await render();
    expect(mocks.usePersistence).toHaveBeenLastCalledWith({
      workspaceId: 'workspace-two',
      sessionId: 'session-a',
    });
    expect(latest().chat.transcriptScroll.identity).toBe('workspace-two/main/session-a');
    expect(latest().chat.transcriptScroll.ready).toBe(false);
    mocks.persistence.ready = true;
    await render();
    expect(latest().chat.transcriptScroll.ready).toBe(true);
  });

  it('clears the requested inactive session before closing it without changing selected-session identity', async () => {
    await render();
    latest().sessionTabs.handleCloseChatSession('session-b');
    expect(mocks.persistence.clearSession).toHaveBeenCalledExactlyOnceWith('session-b');
    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith('session-b');
    expect(mocks.persistence.clearSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeSession.mock.invocationCallOrder[0]!
    );
    expect(latest().chat.sessionId).toBe('session-a');
  });
});
