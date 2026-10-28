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
}));
vi.mock('./kanban-context', () => ({
  useKanban: () => ({ workspaces: [{ id: 'workspace', name: 'Review workspace' }] }),
}));
vi.mock('./quick-chat-content', () => ({ QuickChatContent: () => null }));
vi.mock('@/client/features/workspace', () => ({
  QuickActionsMenu: ({ disabled }: { disabled?: boolean }) =>
    createElement('button', { disabled, 'aria-label': 'Quick actions' }),
}));
vi.mock('./use-quick-chat', () => ({
  useQuickChat: () => ({
    sessions: mocks.empty
      ? []
      : [
          { id: 'first', name: 'Chat 1', status: 'IDLE', createdAt: '2026-10-27T12:00:00Z' },
          { id: 'second', name: 'Chat 2', status: 'IDLE', createdAt: '2026-10-27T12:01:00Z' },
        ],
    selectedSessionId: mocks.empty ? null : 'first',
    setSelectedSessionId: mocks.select,
    handleCloseSession: mocks.close,
    handleNewChat: mocks.create,
    handleQuickAction: vi.fn(),
    isCreatingSession: false,
    sessionsLoaded: mocks.loaded,
    chatState: {},
  }),
}));

beforeEach(() => {
  mocks.empty = false;
  mocks.loaded = true;
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
      }
      expect(document.body.querySelector('[aria-label^="New conversation provider"]')).toBeNull();
      expect(document.body.querySelector('[aria-label^="Thinking level"]')).toBeNull();
      expect(
        document.body.querySelector<HTMLButtonElement>('[aria-label="Quick actions"]')?.disabled
      ).toBe(false);
      const create = document.body.querySelector<HTMLButtonElement>('[aria-label="New session"]');
      expect(create?.disabled).toBe(false);
      await act(() => create?.click());
      expect(mocks.create).toHaveBeenCalledOnce();
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  }
);

it('blocks new chats and quick actions until sessions load', async () => {
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
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Quick actions"]')?.disabled
    ).toBe(true);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
