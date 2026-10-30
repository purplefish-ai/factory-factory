// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from './kanban-board';

const mocks = vi.hoisted(() => ({
  dismissArchiveGitLock: vi.fn(),
  retryGitLockedArchives: vi.fn(),
  archiveWorkspace: vi.fn(async (_workspaceId: string) => undefined),
  columnProps: [] as Array<{
    onArchive: (workspaceId: string) => void;
    onToggleRatcheting: (workspaceId: string, enabled: boolean) => void;
    onRename: (workspaceId: string, name: string) => Promise<void>;
  }>,
}));

vi.mock('@/hooks/use-mobile', () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => true,
}));

vi.mock('./kanban-column', () => ({
  getKanbanColumns: () => [
    {
      id: 'WAITING',
      label: 'Waiting',
      description: 'Waiting for input',
    },
  ],
  KanbanColumn: (props: (typeof mocks.columnProps)[number]) => {
    mocks.columnProps.push(props);
    return <div>Mobile column</div>;
  },
}));

vi.mock('./quick-chat-sheet', () => ({
  QuickChatSheet: () => null,
}));

vi.mock('./kanban-context', () => ({
  useKanban: () => ({
    projectId: 'project-1',
    projectSlug: 'project',
    issueProvider: 'GITHUB',
    workspaces: [],
    issues: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    toggleWorkspaceRatcheting: vi.fn(),
    togglingWorkspaceId: null,
    renameWorkspace: vi.fn(),
    // The real context recreates its commands on every render.
    archiveWorkspace: (workspaceId: string) => mocks.archiveWorkspace(workspaceId),
    bulkArchiveColumn: vi.fn(),
    archiveGitLockWorkspaceIds: ['workspace-1'],
    dismissArchiveGitLock: mocks.dismissArchiveGitLock,
    retryGitLockedArchives: mocks.retryGitLockedArchives,
    isBulkArchiving: false,
    showInlineForm: false,
    setShowInlineForm: vi.fn(),
    quickChatWorkspaceId: null,
    openQuickChat: vi.fn(),
    closeQuickChat: vi.fn(),
  }),
}));

describe('KanbanBoard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalActEnvironmentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT'
    );
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    try {
      void act(() => root.unmount());
      document.body.innerHTML = '';
    } finally {
      if (originalActEnvironmentDescriptor) {
        Object.defineProperty(
          globalThis,
          'IS_REACT_ACT_ENVIRONMENT',
          originalActEnvironmentDescriptor
        );
      } else {
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  });

  it('renders Git index-lock recovery on mobile', () => {
    void act(() => {
      root.render(createElement(KanbanBoard));
    });

    expect(document.body.textContent).toContain('Git is locked');
    expect(document.body.textContent).toContain('Remove Lock and Archive');
  });

  it('passes card handlers with stable identities so memoized cards can skip renders', () => {
    mocks.columnProps.length = 0;
    void act(() => {
      root.render(createElement(KanbanBoard));
    });
    void act(() => {
      root.render(createElement(KanbanBoard));
    });

    const [first, last] = [mocks.columnProps[0], mocks.columnProps.at(-1)];
    expect(mocks.columnProps.length).toBeGreaterThan(1);
    expect(last?.onArchive).toBe(first?.onArchive);
    expect(last?.onToggleRatcheting).toBe(first?.onToggleRatcheting);
    expect(last?.onRename).toBe(first?.onRename);

    last?.onArchive('workspace-2');
    expect(mocks.archiveWorkspace).toHaveBeenCalledWith('workspace-2');
  });
});
