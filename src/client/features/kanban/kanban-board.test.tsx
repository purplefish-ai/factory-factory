// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from './kanban-board';

const mocks = vi.hoisted(() => ({
  dismissArchiveGitLock: vi.fn(),
  retryGitLockedArchives: vi.fn(),
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
  KanbanColumn: () => <div>Mobile column</div>,
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
    archiveWorkspace: vi.fn(),
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
});
