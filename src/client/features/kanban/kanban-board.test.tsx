// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOptimisticWorkspaceSummary } from '@/client/lib/workspace-summary';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KanbanBoard } from './kanban-board';
import type { WorkspaceWithKanban } from './kanban-card';
import { KanbanControls } from './kanban-controls';
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
  isArchiving: false,
  inlineFormRequest: 0,
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
    isArchiving: mocks.isArchiving,
    showInlineForm: mocks.showInlineForm,
    setShowInlineForm: (show: boolean) => {
      mocks.showInlineForm = show;
    },
    inlineFormRequest: mocks.inlineFormRequest,
    requestInlineForm: () => {
      mocks.showInlineForm = true;
      mocks.inlineFormRequest += 1;
    },
    syncAndRefetch: vi.fn(),
    isSyncing: false,
    quickChatWorkspaceId: null,
    openQuickChat: vi.fn(),
    closeQuickChat: vi.fn(),
  }),
}));

// The board's "New Workspace" action lives in the header controls rendered
// beside the board by WorkspacesBoardView.
function BoardWithHeader() {
  return (
    <TooltipProvider>
      <KanbanControls />
      <KanbanBoard />
    </TooltipProvider>
  );
}

function findButton(container: HTMLElement, label: string) {
  return [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label || candidate.getAttribute('aria-label') === label
  );
}

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
    mocks.isArchiving = false;
    mocks.inlineFormRequest = 0;
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
    const button = findButton(container, label);
    expect(button).toBeDefined();
    void act(() => button!.click());
    void act(() => root.render(createElement(BoardWithHeader)));
  }

  it.each([true, false])(
    'offers a saved draft without reopening an explicitly closed composer (mobile=%s)',
    async (mobile) => {
      mocks.isMobile = mobile;
      await saveWorkspaceCreationDraft('project-1', {
        ...createWorkspaceCreationDraft(),
        prompt: 'Resume this task',
      }).catch(() => undefined);
      act(() => root.render(createElement(BoardWithHeader)));
      expect(container.querySelector('input[aria-label="Task name"]')).toBeNull();
      click('New workspace');
      expect(container.querySelector('input[aria-label="Task name"]')).not.toBeNull();
      click('Cancel creation');
      act(() => root.render(createElement(BoardWithHeader)));
      expect(container.querySelector('input[aria-label="Task name"]')).toBeNull();
      expect(findButton(container, 'New workspace')).toBeDefined();
    }
  );

  it.each([true, false])(
    'keeps the filter without sort or selection controls (mobile=%s)',
    (mobile) => {
      mocks.isMobile = mobile;
      mocks.columnProps.length = 0;
      act(() => root.render(createElement(BoardWithHeader)));
      expect(container.querySelector('input[aria-label="Filter board"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Sort workspaces"]')).toBeNull();
      expect(container.textContent).not.toContain('Archive selected');
      expect(mocks.columnProps.length).toBeGreaterThan(0);
      for (const props of mocks.columnProps) {
        expect(props).not.toHaveProperty('onToggleSelected');
        expect(props).not.toHaveProperty('selectedIds');
      }
    }
  );

  it('keeps first-workspace guidance hidden during optimistic archive removal', async () => {
    mocks.workspaces = [];
    mocks.isArchiving = true;
    await act(() => root.render(createElement(BoardWithHeader)));
    expect(container.textContent).not.toContain('Create your first workspace');
    mocks.isArchiving = false;
    await act(() => root.render(createElement(BoardWithHeader)));
    expect(container.textContent).toContain('Create your first workspace');
  });

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
    void act(() => root.render(createElement(BoardWithHeader)));
    click('New workspace');
    const oldScrollContainer = container
      .querySelector('input[aria-label="Task name"]')!
      .closest('.overflow-y-auto')!.parentElement!.parentElement!;
    oldScrollContainer.scrollTop = 200;
    click('Complete creation');
    expect(
      [...container.querySelectorAll('[data-column="WORKING"] span')].map(
        (card) => card.textContent
      )
    ).toEqual(['New task', 'Older working task']);
    expect(container.querySelector('input[aria-label="Task name"]')).toBeNull();
    expect(oldScrollContainer.isConnected).toBe(false);
    expect(container.querySelector('[data-column="WORKING"]')!.parentElement!.scrollTop).toBe(0);
  });

  it.each([true, false])('keeps failed setup discoverable in Waiting (mobile=%s)', (mobile) => {
    mocks.isMobile = mobile;
    act(() => root.render(createElement(BoardWithHeader)));
    click('New workspace');
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
    act(() => root.render(createElement(BoardWithHeader)));
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
    act(() => root.render(createElement(BoardWithHeader)));
    expect(container.querySelector('[data-column="WAITING"]')?.textContent).toContain('New task');
  });

  it('stays on To Do when task creation is cancelled', () => {
    void act(() => root.render(createElement(BoardWithHeader)));
    click('New workspace');
    click('Cancel creation');
    expect(container.querySelector('[data-column="WORKING"]')).toBeNull();
    expect(
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'To Do0')
        ?.className
    ).toContain('bg-primary');
  });

  it('keeps the desktop board visible after creation', () => {
    mocks.isMobile = false;
    void act(() => root.render(createElement(BoardWithHeader)));
    click('New workspace');
    click('Complete creation');
    expect(container.querySelector('[data-column="WORKING"]')?.textContent).toContain('New task');
    expect(container.querySelector('[data-column="WAITING"]')?.textContent).toContain(
      'Existing task'
    );
    expect(container.querySelector('[data-column="DONE"]')).not.toBeNull();
    expect(container.querySelector('input[aria-label="Task name"]')).toBeNull();
  });

  it('creates in Todo on desktop and keeps a mobile shortcut', () => {
    mocks.isMobile = false;
    act(() => root.render(createElement(BoardWithHeader)));
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.filter((button) => button.textContent === 'New workspace')).toHaveLength(1);
    expect(findButton(container, 'New workspace')?.closest('[data-todo-column]')).not.toBeNull();
    expect(buttons.some((button) => button.textContent === 'New Task')).toBe(false);

    mocks.isMobile = true;
    act(() => root.render(createElement(BoardWithHeader)));
    const mobileButton = findButton(container, 'New workspace');
    expect(mobileButton?.textContent).toBe('');
    expect(mobileButton?.getAttribute('aria-label')).toBe('New workspace');
  });

  it('reveals an already open form when New Workspace is pressed from another mobile tab', () => {
    act(() => root.render(createElement(BoardWithHeader)));
    click('New workspace');
    expect(container.querySelector('input[aria-label="Task name"]')).not.toBeNull();
    click('Waiting1');
    expect(container.querySelector('input[aria-label="Task name"]')).toBeNull();
    expect(mocks.showInlineForm).toBe(true);
    click('New workspace');
    expect(container.querySelector('input[aria-label="Task name"]')).not.toBeNull();
  });

  it('keeps a mobile New Workspace request made before workspaces load', () => {
    const loaded = mocks.workspaces;
    mocks.workspaces = undefined as unknown as WorkspaceWithKanban[];
    act(() => root.render(createElement(BoardWithHeader)));
    click('New workspace');
    expect(container.querySelector('input[aria-label="Task name"]')).not.toBeNull();
    // Loaded data includes a Waiting workspace, which would normally be the first tab.
    mocks.workspaces = loaded;
    act(() => root.render(createElement(BoardWithHeader)));
    expect(container.querySelector('input[aria-label="Task name"]')).not.toBeNull();
    expect(container.querySelector('[data-column="WAITING"]')).toBeNull();
  });

  it('renders Git index-lock recovery on mobile', () => {
    void act(() => {
      root.render(createElement(BoardWithHeader));
    });

    expect(document.body.textContent).toContain('Git is locked');
    expect(document.body.textContent).toContain('Remove Lock and Archive');
  });

  it('passes card handlers with stable identities so memoized cards can skip renders', () => {
    mocks.columnProps.length = 0;
    void act(() => {
      root.render(createElement(BoardWithHeader));
    });
    void act(() => {
      root.render(createElement(BoardWithHeader));
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
