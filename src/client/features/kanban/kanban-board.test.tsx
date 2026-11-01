// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import { KanbanBoard } from './kanban-board';
import type { WorkspaceWithKanban } from './kanban-card';
import {
  clearWorkspaceCreationDraft,
  createWorkspaceCreationDraft,
  getWorkspaceCreationDraftSnapshot,
  loadWorkspaceCreationDraft,
  saveWorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

const mocks = vi.hoisted(() => ({
  isMobile: true,
  showInlineForm: false,
  workspaces: [] as WorkspaceWithKanban[],
  dismissArchiveGitLock: vi.fn(),
  retryGitLockedArchives: vi.fn(),
  archiveWorkspace: vi.fn(async (_workspaceId: string) => undefined),
  columnProps: [] as Array<{
    column: { id: string };
    workspaces: WorkspaceWithKanban[];
    onArchive: (workspaceId: string) => void;
    onToggleRatcheting: (workspaceId: string, enabled: boolean) => void;
    onRename: (workspaceId: string, name: string) => Promise<void>;
  }>,
}));

vi.mock('@/hooks/use-mobile', () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => mocks.isMobile,
}));

vi.mock('./kanban-column', () => ({
  getKanbanColumns: () => [
    { id: 'ISSUES', label: 'To Do', description: 'Tasks' },
    { id: 'WORKING', label: 'Working', description: 'Agent is working' },
    { id: 'DONE', label: 'Done', description: 'PR merged' },
    {
      id: 'WAITING',
      label: 'Waiting',
      description: 'Waiting for input',
    },
  ],
  KanbanColumn: (props: (typeof mocks.columnProps)[number]) => {
    mocks.columnProps.push(props);
    return (
      <div data-column={props.column.id}>
        {props.workspaces.map((workspace) => (
          <span key={workspace.id}>{workspace.name}</span>
        ))}
      </div>
    );
  },
}));

vi.mock('./issue-details-sheet', () => ({ IssueDetailsSheet: () => null }));
vi.mock('./inline-workspace-form', () => ({
  InlineWorkspaceForm: ({
    onCreated,
    onCancel,
  }: {
    onCreated: (id: string) => void;
    onCancel: () => void;
  }) => (
    <div>
      <input aria-label="Task name" defaultValue="New task" />
      <button
        type="button"
        onClick={() => {
          mocks.workspaces = [
            createOptimisticWorkspaceSummary({
              id: 'new-task',
              projectId: 'project-1',
              name: 'New task',
              ratchetEnabled: true,
            }),
            ...mocks.workspaces,
          ];
          onCreated('new-task');
        }}
      >
        Complete creation
      </button>
      <button type="button" onClick={onCancel}>
        Cancel creation
      </button>
    </div>
  ),
}));

vi.mock('./quick-chat-sheet', () => ({
  QuickChatSheet: () => null,
}));

vi.mock('./kanban-context', () => ({
  useKanban: () => ({
    projectId: 'project-1',
    projectSlug: 'project',
    issueProvider: 'GITHUB',
    workspaces: mocks.workspaces,
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
    showInlineForm: mocks.showInlineForm,
    setShowInlineForm: (show: boolean) => {
      mocks.showInlineForm = show;
    },
    quickChatWorkspaceId: null,
    openQuickChat: vi.fn(),
    closeQuickChat: vi.fn(),
  }),
}));

describe('KanbanBoard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalActEnvironmentDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    await loadWorkspaceCreationDraft('project-1').catch(() => undefined);
    const previous = getWorkspaceCreationDraftSnapshot('project-1').draft;
    if (previous) {
      await clearWorkspaceCreationDraft('project-1', previous.revision).catch(() => undefined);
    }
    mocks.isMobile = true;
    mocks.showInlineForm = false;
    mocks.workspaces = [
      {
        ...createOptimisticWorkspaceSummary({
          id: 'existing',
          projectId: 'project-1',
          name: 'Existing task',
          ratchetEnabled: true,
        }),
        kanbanColumn: 'WAITING',
      },
    ];
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

  function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label
    );
    expect(button).toBeDefined();
    void act(() => button!.click());
    void act(() => root.render(createElement(KanbanBoard)));
  }

  it.each([true, false])(
    'offers a saved draft without reopening an explicitly closed composer (mobile=%s)',
    async (mobile) => {
      mocks.isMobile = mobile;
      await saveWorkspaceCreationDraft('project-1', {
        ...createWorkspaceCreationDraft(),
        prompt: 'Resume this task',
      }).catch(() => undefined);
      act(() => root.render(createElement(KanbanBoard)));
      expect(container.querySelector('input')).toBeNull();
      click('New Task');
      expect(container.querySelector('input')).not.toBeNull();
      click('Cancel creation');
      act(() => root.render(createElement(KanbanBoard)));
      expect(container.querySelector('input')).toBeNull();
      expect(container.textContent).toContain('New Task');
    }
  );

  it('shows the created task at the top of Working on mobile', () => {
    mocks.workspaces.push(
      createOptimisticWorkspaceSummary({
        id: 'older-working',
        projectId: 'project-1',
        name: 'Older working task',
        ratchetEnabled: true,
        createdAt: new Date(Date.now() - 60_000),
      })
    );
    void act(() => root.render(createElement(KanbanBoard)));
    click('New Task');
    const oldScrollContainer = container.querySelector('input')!.closest('.overflow-y-auto')!
      .parentElement!.parentElement!;
    oldScrollContainer.scrollTop = 200;
    click('Complete creation');
    expect(
      [...container.querySelectorAll('[data-column="WORKING"] span')].map(
        (card) => card.textContent
      )
    ).toEqual(['New task', 'Older working task']);
    expect(container.querySelector('input')).toBeNull();
    expect(oldScrollContainer.isConnected).toBe(false);
    expect(container.querySelector('[data-column="WORKING"]')!.parentElement!.scrollTop).toBe(0);
  });

  it.each([true, false])('keeps failed setup discoverable in Waiting (mobile=%s)', (mobile) => {
    mocks.isMobile = mobile;
    act(() => root.render(createElement(KanbanBoard)));
    click('New Task');
    click('Complete creation');
    mocks.workspaces = mocks.workspaces.map((workspace) =>
      workspace.id === 'new-task'
        ? {
            ...workspace,
            status: 'FAILED',
            kanbanColumn: 'WAITING',
            isWorking: false,
            initErrorMessage: 'Git worktree failed',
            statusReason: {
              code: 'SETUP_FAILED',
              label: 'Setup failed',
              tone: 'danger',
              needsUser: true,
            },
          }
        : workspace
    );
    act(() => root.render(createElement(KanbanBoard)));
    expect(container.querySelector('[data-column="WORKING"]')?.textContent).not.toContain(
      'New task'
    );
    if (mobile) {
      click('Waiting2');
    }
    expect(container.querySelector('[data-column="WAITING"]')?.textContent).toContain('New task');
    // Remounting the board keeps the failed task supplied by its query visible.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(createElement(KanbanBoard)));
    expect(container.querySelector('[data-column="WAITING"]')?.textContent).toContain('New task');
  });

  it('stays on To Do when task creation is cancelled', () => {
    void act(() => root.render(createElement(KanbanBoard)));
    click('New Task');
    click('Cancel creation');
    expect(container.querySelector('[data-column="WORKING"]')).toBeNull();
    expect(
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'To Do0')
        ?.className
    ).toContain('bg-primary');
  });

  it('keeps the desktop board visible after creation', () => {
    mocks.isMobile = false;
    void act(() => root.render(createElement(KanbanBoard)));
    click('New Task');
    click('Complete creation');
    expect(container.querySelector('[data-column="WORKING"]')?.textContent).toContain('New task');
    expect(container.querySelector('[data-column="WAITING"]')?.textContent).toContain(
      'Existing task'
    );
    expect(container.querySelector('[data-column="DONE"]')).not.toBeNull();
    expect(container.querySelector('input')).toBeNull();
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
