// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceContentView, type WorkspaceContentViewProps } from './workspace-content-view';

vi.mock('./main-view-tab-bar', () => ({ MainViewTabBar: () => null }));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const panel = vi.hoisted(() => ({
  tabs: [] as { id: string; type: string; path: string }[],
  activeTabId: 'chat',
  openTab: vi.fn(),
}));
vi.mock('./use-chat-transcript-persistence', () => ({
  useTranscriptPositionPersistence: () => ({}),
}));
vi.mock('@/client/features/subagents', () => ({ SubagentTranscriptView: () => null }));
vi.mock('./closed-session-transcript-view', () => ({ ClosedSessionTranscriptView: () => null }));
vi.mock('./screenshot-viewer-tab', () => ({ ScreenshotViewerTab: () => null }));
vi.mock('./file-viewer', () => ({ FileViewer: () => <p>File viewer</p> }));
vi.mock('./diff-viewer', () => ({ DiffViewer: () => <p>Diff viewer</p> }));
vi.mock('./workspace-panel-context', () => ({ useWorkspacePanel: () => panel }));

describe('WorkspaceContentView sessionless recovery', () => {
  it.each(['file', 'diff'])(
    'keeps sessionless recovery outside the hidden chat pane with an active %s tab',
    async (type) => {
      panel.tabs = [{ id: 'persisted', type, path: 'README.md' }];
      panel.activeTabId = 'persisted';
      const container = document.createElement('div');
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(
            <WorkspaceContentView
              workspaceId="ws-1"
              sessions={[]}
              selectedSessionId={null}
              sessionSummariesById={new Map()}
              isCreatingSession={false}
              isDeletingSession={false}
              onSelectSession={vi.fn()}
              onCreateSession={vi.fn()}
              onCloseSession={vi.fn()}
              hasWorktreePath={false}
              emptyState={<button>Retry setup</button>}
            >
              <p>Chat</p>
            </WorkspaceContentView>
          )
        );
        const retry = container.querySelector('button');
        expect(retry).not.toBeNull();
        expect(container.querySelectorAll('button')).toHaveLength(1);
        expect(retry?.closest('.hidden')).toBeNull();
        expect(container.textContent).toContain(type === 'file' ? 'File viewer' : 'Diff viewer');
        expect(panel.activeTabId).toBe('persisted');
        expect(panel.openTab).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        panel.tabs = [];
        panel.activeTabId = 'chat';
      }
    }
  );

  it('renders supplied recovery without sessions and preserves chat while sessions load', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const props: WorkspaceContentViewProps = {
      workspaceId: 'ws-1',
      sessions: [],
      selectedSessionId: null,
      sessionSummariesById: new Map(),
      isCreatingSession: false,
      isDeletingSession: false,
      onSelectSession: vi.fn(),
      onCreateSession: vi.fn(),
      onCloseSession: vi.fn(),
      hasWorktreePath: false,
      children: <p>Conversation content</p>,
      emptyState: <p>Worktree failed. Retry setup.</p>,
    };
    try {
      act(() => root.render(<WorkspaceContentView {...props} />));
      expect(container.textContent).toContain('Worktree failed. Retry setup.');
      expect(container.textContent).not.toContain('initializing');
      expect(container.textContent).not.toContain('Conversation content');
      act(() => root.render(<WorkspaceContentView {...props} sessions={undefined} />));
      expect(container.textContent).toContain('Conversation content');
      expect(container.textContent).not.toContain('Retry setup');
      act(() => root.render(<WorkspaceContentView {...props} emptyState={undefined} />));
      expect(container.textContent).toContain('Start a Session');
      expect(container.textContent).toContain('Workspace is initializing');
    } finally {
      act(() => root.unmount());
    }
  });
});
