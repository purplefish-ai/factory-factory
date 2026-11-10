// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { QuickChatSheet } from './quick-chat-sheet';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  close: vi.fn(),
  create: vi.fn(),
  empty: false,
  loaded: true,
  selectionPending: false,
  error: null as Error | null,
  fetching: false,
  refetch: vi.fn(),
  workspaceProvider: 'CLAUDE' as 'CLAUDE' | 'CODEX' | 'WORKSPACE_DEFAULT',
  content: vi.fn(),
  maxSessions: 2,
  maxSessionsError: false,
  maxSessionsRefreshError: false,
  retryLimit: vi.fn(),
  deleting: false,
  worktreePath: '/tmp/worktree' as string | null,
}));
vi.mock('./kanban-context', () => ({
  useKanban: () => ({
    workspaces: [
      {
        id: 'workspace',
        name: 'Review workspace',
        worktreePath: mocks.worktreePath,
        defaultSessionProvider: mocks.workspaceProvider,
      },
    ],
  }),
}));
vi.mock('./quick-chat-content', () => ({
  QuickChatContent: (props: unknown) => {
    mocks.content(props);
    return null;
  },
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      getMaxSessionsPerWorkspace: {
        useQuery: () => ({
          data: mocks.maxSessionsError ? undefined : mocks.maxSessions,
          error:
            mocks.maxSessionsError || mocks.maxSessionsRefreshError
              ? { message: 'Database is locked' }
              : null,
          isFetching: false,
          refetch: mocks.retryLimit,
        }),
      },
    },
    userSettings: { get: { useQuery: () => ({ data: { defaultSessionProvider: 'CODEX' } }) } },
    codexAccounts: {
      list: {
        useQuery: () => ({
          data: [
            { id: 'personal', label: 'Personal', authenticated: true },
            { id: 'work', label: 'Work', authenticated: true },
          ],
        }),
      },
    },
  },
}));
vi.mock('@/client/features/workspace', async () => {
  const actual = await vi.importActual<typeof import('@/client/features/workspace')>(
    '@/client/features/workspace'
  );
  return { getNewChatUnavailableReason: actual.getNewChatUnavailableReason };
});
vi.mock('./use-quick-chat', () => ({
  useQuickChat: () => ({
    sessions: mocks.empty
      ? []
      : [
          { id: 'first', name: 'Chat 1', status: 'IDLE', createdAt: '2026-10-27T12:00:00Z' },
          { id: 'second', name: 'Chat 2', status: 'IDLE', createdAt: '2026-10-27T12:01:00Z' },
        ],
    selectedSessionId: mocks.empty || mocks.selectionPending ? null : 'first',
    selectedCodexAccountId: 'work',
    setSelectedSessionId: mocks.select,
    handleCloseSession: mocks.close,
    handleNewChat: mocks.create,
    handleQuickAction: vi.fn(),
    isCreatingSession: false,
    isDeletingSession: mocks.deleting,
    sessionsLoaded: mocks.loaded,
    sessionsError: mocks.error,
    refetchSessions: mocks.refetch,
    isFetchingSessions: mocks.fetching,
    chatState: {},
  }),
}));

beforeEach(() => {
  mocks.empty = false;
  mocks.loaded = true;
  mocks.selectionPending = false;
  mocks.error = null;
  mocks.fetching = false;
  mocks.workspaceProvider = 'CLAUDE';
  mocks.maxSessions = 10;
  mocks.maxSessionsError = false;
  mocks.maxSessionsRefreshError = false;
  mocks.deleting = false;
  mocks.worktreePath = '/tmp/worktree';
  vi.clearAllMocks();
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
});

it.each([false, true])(
  'creates sessions directly without launch pickers (empty=%s)',
  async (empty) => {
    mocks.empty = empty;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(createElement(QuickChatSheet, { workspaceId: 'workspace', onClose: vi.fn() }))
      );
      if (!empty) {
        const secondTab = [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find(
          (tab) => tab.textContent?.includes('Chat 2')
        );
        await act(() => secondTab?.click());
        expect(mocks.select).toHaveBeenCalledWith('second');
        const close = document.body.querySelector<HTMLButtonElement>('[aria-label="Close Chat 1"]');
        expect(close?.disabled).toBe(false);
        await act(() => close?.click());
        expect(mocks.close).toHaveBeenCalledWith('first');
      } else {
        expect(document.body.querySelector('[role="tab"]')).toBeNull();
        expect(document.body.textContent).toContain('No chats yet');
        expect(document.body.textContent).not.toContain('Loading sessions…');
      }
      expect(document.body.querySelector('[aria-label^="New conversation provider"]')).toBeNull();
      expect(document.body.querySelector('[aria-label^="Thinking level"]')).toBeNull();
      // Quick actions live in the composer, which can also start them in a new chat.
      if (!empty) {
        expect(mocks.content).toHaveBeenLastCalledWith(
          expect.objectContaining({
            onRunQuickActionInNewChat: expect.any(Function),
            newChatUnavailableReason: null,
          })
        );
      }
      expect(document.body.querySelector('[aria-label="Quick actions"]')).toBeNull();
      const create = empty
        ? [...document.body.querySelectorAll('button')].find(
            (button) => button.textContent === 'New chat'
          )
        : document.body.querySelector<HTMLButtonElement>('[aria-label="New session"]');
      expect(create?.disabled).toBe(false);
      await act(() => create?.click());
      expect(mocks.create).toHaveBeenCalledOnce();
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  }
);

it('blocks new chats until sessions load', async () => {
  mocks.empty = true;
  mocks.loaded = false;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(createElement(QuickChatSheet, { workspaceId: 'workspace', onClose: vi.fn() }))
    );
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="New session"]')?.disabled
    ).toBe(true);
    // No composer yet, so no quick actions either.
    expect(mocks.content).not.toHaveBeenCalled();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it.each(['CODEX', 'WORKSPACE_DEFAULT'] as const)(
  'keeps named account creation in an empty %s workspace and forwards the selected binding to the composer',
  async (provider) => {
    mocks.empty = true;
    mocks.workspaceProvider = provider;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(createElement(QuickChatSheet, { workspaceId: 'workspace', onClose: vi.fn() }))
      );
      await act(() =>
        document.body
          .querySelector('[aria-label="New session"]')
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      );
      const work = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent === 'Work'
      );
      expect(work).toBeDefined();
      await act(() => work?.click());
      expect(mocks.create).toHaveBeenCalledWith('work');
      mocks.empty = false;
      await act(() =>
        root.render(createElement(QuickChatSheet, { workspaceId: 'workspace', onClose: vi.fn() }))
      );
      expect(mocks.content).toHaveBeenLastCalledWith(
        expect.objectContaining({ codexAccountId: 'work' })
      );
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  }
);

it('keeps a loaded nonempty list pending until its first session is selected', async () => {
  mocks.selectionPending = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<QuickChatSheet workspaceId="workspace" onClose={vi.fn()} />));
    expect(document.body.textContent).toContain('Loading sessions…');
    expect(document.body.textContent).not.toContain('No chats yet');
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it('offers session-list Retry after failure and disables only Retry while refetching', async () => {
  mocks.empty = true;
  mocks.loaded = false;
  mocks.error = new Error('Offline');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<QuickChatSheet workspaceId="workspace" onClose={vi.fn()} />));
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Offline');
    const retry = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    expect(retry?.disabled).toBe(false);
    await act(() => retry?.click());
    expect(mocks.refetch).toHaveBeenCalledOnce();
    mocks.fetching = true;
    await act(() => root.render(<QuickChatSheet workspaceId="workspace" onClose={vi.fn()} />));
    expect(
      [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retrying…'
      )?.disabled
    ).toBe(true);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it.each([
  {
    maxSessions: 2,
    worktreePath: '/tmp/worktree',
    reason: 'This workspace already has the maximum of 2 active chats.',
  },
  {
    maxSessions: 10,
    worktreePath: null,
    reason: 'New chats can start once the workspace is set up.',
  },
])(
  'disables new-chat actions when unavailable: $reason',
  async ({ maxSessions, worktreePath, reason }) => {
    mocks.maxSessions = maxSessions;
    mocks.worktreePath = worktreePath;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() => root.render(<QuickChatSheet workspaceId="workspace" onClose={vi.fn()} />));
      expect(mocks.content).toHaveBeenLastCalledWith(
        expect.objectContaining({ newChatUnavailableReason: reason })
      );
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  }
);

it('reports and retries a failed chat-limit query instead of claiming chats are loading', async () => {
  mocks.maxSessionsError = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<QuickChatSheet workspaceId="workspace" onClose={vi.fn()} />));
    expect(mocks.content).toHaveBeenLastCalledWith(
      expect.objectContaining({ newChatUnavailableReason: "Couldn't load the chat limit." })
    );
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load the chat limit");
    expect(alert?.textContent).toContain('Database is locked');
    const retry = alert?.querySelector('button');
    await act(() => retry?.click());
    expect(mocks.retryLimit).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
it('keeps applying a cached chat limit when only its refetch failed', async () => {
  mocks.maxSessionsRefreshError = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<QuickChatSheet workspaceId="workspace" onClose={vi.fn()} />));
    expect(mocks.content).toHaveBeenLastCalledWith(
      expect.objectContaining({ newChatUnavailableReason: null })
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
    const notice = document.querySelector('[role="status"]');
    expect(notice?.textContent).toContain("Couldn't refresh the chat limit");
    await act(() => notice?.querySelector('button')?.click());
    expect(mocks.retryLimit).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
it('keeps new-chat actions disabled while a chat is closing', async () => {
  mocks.deleting = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<QuickChatSheet workspaceId="workspace" onClose={vi.fn()} />));
    expect(mocks.content).toHaveBeenLastCalledWith(
      expect.objectContaining({ newChatUnavailableReason: 'A chat is closing.' })
    );
    expect(document.querySelector<HTMLButtonElement>('[aria-label="New session"]')?.disabled).toBe(
      true
    );
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it('explains why the first chat cannot start before workspace setup finishes', async () => {
  mocks.empty = true;
  mocks.worktreePath = null;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<QuickChatSheet workspaceId="workspace" onClose={vi.fn()} />));
    expect(document.body.textContent).toContain(
      'New chats can start once the workspace is set up.'
    );
    const create = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'New chat'
    );
    expect(create?.disabled).toBe(true);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
