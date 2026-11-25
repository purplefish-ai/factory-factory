// @vitest-environment jsdom

import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeaderProvider, useAppHeaderContext } from '@/client/components/app-header-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { settle } from '@/test-utils/react-act';
import { KanbanBoard } from './kanban-board';
import type { WorkspaceWithKanban } from './kanban-card';
import { baseWorkspace } from './kanban-card.story-fixtures';
import { KanbanControls } from './kanban-controls';

const mocks = vi.hoisted(() => {
  let selecting = false;
  const listeners = new Set<() => void>();
  const setSelecting = (value: boolean) => {
    selecting = value;
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    workspaces: [] as WorkspaceWithKanban[],
    archiveWorkspaces: vi.fn(async (_ids: readonly string[]) => ({ failedIds: [] as string[] })),
    selection: {
      get: () => selecting,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start: () => setSelecting(true),
      stop: () => setSelecting(false),
      reset: () => {
        selecting = false;
      },
    },
  };
});

vi.mock('@/hooks/use-mobile', () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => false,
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: { workspace: { listChildren: { useQuery: () => ({ data: undefined }) } } },
}));

vi.mock('./quick-chat-sheet', () => ({ QuickChatSheetBody: () => null }));

vi.mock('./kanban-context', () => ({
  useKanban: () => ({
    projectId: 'project-1',
    projectSlug: 'project',
    issueProvider: 'GITHUB',
    workspaces: mocks.workspaces,
    issues: [],
    isLoading: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
    toggleWorkspaceRatcheting: vi.fn(),
    togglingWorkspaceIds: [],
    renameWorkspace: vi.fn(),
    archiveWorkspace: vi.fn(),
    archiveWorkspaces: mocks.archiveWorkspaces,
    isSelecting: useSyncExternalStore(mocks.selection.subscribe, mocks.selection.get),
    startSelecting: mocks.selection.start,
    stopSelecting: mocks.selection.stop,
    archiveGitLockWorkspaceIds: [],
    dismissArchiveGitLock: vi.fn(),
    retryGitLockedArchives: vi.fn(),
    isBulkArchiving: false,
    isArchiving: false,
    showInlineForm: false,
    setShowInlineForm: vi.fn(),
    inlineFormRequest: 0,
    requestInlineForm: vi.fn(),
    syncAndRefetch: vi.fn(),
    isSyncing: false,
    quickChatWorkspaceId: null,
    openQuickChat: vi.fn(),
    closeQuickChat: vi.fn(),
  }),
}));

function workspace(
  id: string,
  kanbanColumn: 'WORKING' | 'WAITING' | 'DONE',
  minutesAgo: number,
  overrides: Partial<WorkspaceWithKanban> = {}
): WorkspaceWithKanban {
  return {
    ...baseWorkspace,
    id,
    name: `Task ${id}`,
    kanbanColumn,
    branchName: null,
    // Waiting sorts by latest message; this keeps the board order w1, w2, w3, w4.
    lastActivityAt: new Date(Date.UTC(2026, 10, 1, 12, 60 - minutesAgo)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 10, 1, 12, 60 - minutesAgo)),
    ...overrides,
  };
}

function TestHeader() {
  const { setLeftStartSlot, setLeftExtraSlot } = useAppHeaderContext();
  return (
    <header>
      <div ref={setLeftStartSlot} />
      <div ref={setLeftExtraSlot} />
    </header>
  );
}

function Board() {
  return (
    <MemoryRouter>
      <TooltipProvider>
        <AppHeaderProvider>
          <TestHeader />
          <KanbanControls />
          <KanbanBoard />
        </AppHeaderProvider>
      </TooltipProvider>
    </MemoryRouter>
  );
}

let container: HTMLDivElement;
let root: Root;
let actEnvironment: PropertyDescriptor | undefined;

class StubResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  mocks.selection.reset();
  mocks.archiveWorkspaces.mockReset();
  mocks.archiveWorkspaces.mockResolvedValue({ failedIds: [] });
  mocks.workspaces = [
    workspace('r1', 'WORKING', 1, { isWorking: true }),
    workspace('w1', 'WAITING', 1, {
      gitStats: { total: 3, additions: 2, deletions: 1, hasUncommitted: true },
    }),
    workspace('w2', 'WAITING', 2),
    workspace('w3', 'WAITING', 3),
    workspace('w4', 'WAITING', 4),
    workspace('d1', 'DONE', 1),
  ];
  actEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Board />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  if (actEnvironment) {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', actEnvironment);
  } else {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});

function rerender() {
  act(() => root.render(<Board />));
}

function button(name: string, scope: ParentNode = document.body) {
  const found = [...scope.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name
  );
  expect(found, `Missing button: ${name}`).toBeDefined();
  return found!;
}

function checkbox(name: string) {
  const found = document.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${name}"]`);
  expect(found, `Missing checkbox: ${name}`).not.toBeNull();
  return found!;
}

function card(id: string) {
  return container.querySelector<HTMLElement>(`[data-workspace-id="${id}"]`)!;
}

function clickElement(element: HTMLElement, init: MouseEventInit = {}) {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
}

function selectedCardIds() {
  return [...container.querySelectorAll('[data-workspace-id][data-selected="true"]')].map((el) =>
    el.getAttribute('data-workspace-id')
  );
}

function selectionStatus() {
  return container.querySelector('section[aria-label="Workspace selection"] [aria-live]')
    ?.textContent;
}

async function enterSelectionMode() {
  const trigger = button('Board actions');
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  clickElement(button('Select workspaces'));
  // Focus moves to the first checkbox once the menu has closed.
  await settle(1);
}

describe('KanbanBoard selection mode', () => {
  it('shows no checkboxes until selection mode is entered from Board actions', async () => {
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    expect(container.querySelector('a[href="/projects/project/workspaces/w1"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="Workspace selection"]')).toBeNull();

    await enterSelectionMode();

    expect(mocks.selection.get()).toBe(true);
    expect(container.querySelectorAll('[data-board-selection-checkbox]')).toHaveLength(6);
    expect(checkbox('Select all in Waiting')).toHaveProperty('ariaChecked', 'false');
    expect(container.querySelector('a[href^="/projects/project/workspaces/"]')).toBeNull();
    expect(selectionStatus()).toContain('0 selected');
    expect(document.activeElement).toBe(checkbox('Select Task r1'));
  });

  it('toggles a card on click instead of opening it', async () => {
    await enterSelectionMode();
    clickElement(card('w2'));
    expect(selectedCardIds()).toEqual(['w2']);
    expect(checkbox('Select Task w2').getAttribute('aria-checked')).toBe('true');
    expect(selectionStatus()).toContain('1 selected');
    clickElement(checkbox('Select Task w2'));
    expect(selectedCardIds()).toEqual([]);
  });

  it('selects a range within a column on shift-click, never across columns', async () => {
    await enterSelectionMode();
    clickElement(checkbox('Select Task w1'));
    clickElement(card('w3'), { shiftKey: true });
    expect(selectedCardIds()).toEqual(['w1', 'w2', 'w3']);

    // The anchor is now w3; a shift-click in another column toggles only that card.
    clickElement(card('d1'), { shiftKey: true });
    expect(selectedCardIds()).toEqual(['w1', 'w2', 'w3', 'd1']);

    // A range from an unselected card clears it.
    clickElement(card('w4'));
    clickElement(card('w2'), { shiftKey: true });
    expect(selectedCardIds()).toEqual(['w1', 'd1']);
  });

  it('selects all of one column and clears it when everything is selected', async () => {
    await enterSelectionMode();
    clickElement(card('w2'));
    expect(checkbox('Select all in Waiting').getAttribute('aria-checked')).toBe('mixed');
    clickElement(checkbox('Select all in Waiting'));
    expect(selectedCardIds()).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(checkbox('Select all in Waiting').getAttribute('aria-checked')).toBe('true');
    expect(selectionStatus()).toContain('4 selected');
    clickElement(checkbox('Select all in Waiting'));
    expect(selectedCardIds()).toEqual([]);
  });

  it('leaves selection mode on Escape or Cancel and returns focus to Board actions', async () => {
    await enterSelectionMode();
    clickElement(card('w1'));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(mocks.selection.get()).toBe(false);
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    expect(document.activeElement).toBe(button('Board actions'));

    await enterSelectionMode();
    expect(selectedCardIds()).toEqual([]);
    const cancel = button('Cancel', container);
    act(() => cancel.focus());
    clickElement(cancel);
    expect(mocks.selection.get()).toBe(false);
    expect(document.activeElement).toBe(button('Board actions'));
  });

  it('counts only cards the filter shows', async () => {
    await enterSelectionMode();
    clickElement(checkbox('Select all in Waiting'));
    const filter = document.querySelector<HTMLInputElement>('input[aria-label="Filter board"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        filter,
        'Task w1'
      );
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(selectionStatus()).toContain('1 selected');
    clickElement(button('Archive', container));
    expect(document.body.textContent).toContain('Archive 1 workspace?');
  });

  it('confirms the count and risks, archives exactly the selection, then leaves the mode', async () => {
    await enterSelectionMode();
    clickElement(card('w2'));
    clickElement(card('w1'));
    clickElement(card('r1'));
    clickElement(button('Archive', container));

    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Archive 3 workspaces?');
    expect(dialog.textContent).toContain('Agent running (1): Task r1');
    expect(dialog.textContent).toContain('Uncommitted changes (1): Task w1');
    expect(dialog.textContent).not.toContain('Open pull request');

    await act(async () => button('Archive 3', dialog).click());

    expect(mocks.archiveWorkspaces).toHaveBeenCalledExactlyOnceWith(['r1', 'w1', 'w2']);
    expect(mocks.selection.get()).toBe(false);
  });

  it('returns focus to the action bar when the confirmation is cancelled', async () => {
    await enterSelectionMode();
    clickElement(card('w1'));
    const archive = button('Archive', container);
    act(() => archive.focus());
    clickElement(archive);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    clickElement(button('Cancel', dialog));
    await settle(2);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button('Archive', container));
    expect(mocks.archiveWorkspaces).not.toHaveBeenCalled();
    expect(selectedCardIds()).toEqual(['w1']);
  });

  it('stays in selection mode with the failed cards still selected', async () => {
    let finish!: (value: { failedIds: string[] }) => void;
    mocks.archiveWorkspaces.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await enterSelectionMode();
    clickElement(card('w1'));
    clickElement(card('w2'));
    clickElement(button('Archive', container));
    await act(async () => button('Archive 2', document.body).click());
    expect(selectionStatus()).toContain('Archiving');

    // w2 archived and left the list; w1 failed and is back on the board.
    mocks.workspaces = mocks.workspaces.filter(({ id }) => id !== 'w2');
    rerender();
    await act(async () => finish({ failedIds: ['w1'] }));

    expect(mocks.selection.get()).toBe(true);
    expect(selectedCardIds()).toEqual(['w1']);
    expect(selectionStatus()).toContain('1 selected');
  });
});
