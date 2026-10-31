// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceContentView, type WorkspaceContentViewProps } from './workspace-content-view';

vi.mock('./main-view-tab-bar', () => ({ MainViewTabBar: () => null }));
vi.mock('./main-view-content', () => ({
  MainViewContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./workspace-panel-context', () => ({ useWorkspacePanel: () => ({ openTab: vi.fn() }) }));

describe('WorkspaceContentView sessionless recovery', () => {
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
