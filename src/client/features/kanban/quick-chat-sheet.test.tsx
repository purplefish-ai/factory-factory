// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { QuickChatSheet } from './quick-chat-sheet';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  close: vi.fn(),
  create: vi.fn(),
  retry: vi.fn(),
  empty: false,
  ready: false,
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
    chatState: {},
    launchSelection: {
      ready: mocks.ready,
      unavailableReason: mocks.ready ? undefined : 'Could not load chat defaults',
      loading: false,
      controlsProps: {
        provider: null,
        models: [],
        error: mocks.ready ? undefined : 'Could not load chat defaults',
        onRetry: mocks.retry,
      },
    },
  }),
}));

beforeEach(() => {
  mocks.empty = false;
  mocks.ready = false;
  vi.clearAllMocks();
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
});

it.each([false, true])(
  'keeps Quick Chat navigation usable while creation defaults fail (empty=%s)',
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
        expect(secondTab?.getAttribute('aria-disabled')).toBe('false');
        await act(() => secondTab?.click());
        expect(mocks.select).toHaveBeenCalledWith('second');
        const close = document.body.querySelector<HTMLButtonElement>('[aria-label="Close Chat 1"]');
        expect(close?.disabled).toBe(false);
        await act(() => close?.click());
        expect(mocks.close).toHaveBeenCalledWith('first');
      } else {
        expect(document.body.querySelector('[role="tab"]')).toBeNull();
        expect(mocks.select).not.toHaveBeenCalled();
      }
      expect(
        document.body.querySelector<HTMLButtonElement>('[aria-label="New session"]')?.disabled
      ).toBe(true);
      expect(
        document.body.querySelector<HTMLButtonElement>('[aria-label="Quick actions"]')?.disabled
      ).toBe(true);
      const retry = document.body.querySelector<HTMLButtonElement>(
        '[aria-label$="Retry selection"]'
      );
      expect(retry?.disabled).toBe(false);
      await act(() => retry?.click());
      expect(mocks.retry).toHaveBeenCalledOnce();
      expect(mocks.create).not.toHaveBeenCalled();
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  }
);

it('explains blocked creation and clears its disabled reason after defaults recover', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () =>
    act(() =>
      root.render(createElement(QuickChatSheet, { workspaceId: 'workspace', onClose: vi.fn() }))
    );
  try {
    await render();
    const blocked = document.body.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    expect(blocked?.title).toBe('Could not load chat defaults');
    expect(blocked?.classList.contains('disabled:pointer-events-none')).toBe(false);
    expect(blocked?.getAttribute('aria-description')).toBe('Could not load chat defaults');
    mocks.ready = true;
    await render();
    const available = document.body.querySelector<HTMLButtonElement>('[aria-label="New session"]');
    expect(available?.disabled).toBe(false);
    expect(available?.title).toBe('New Session');
    expect(available?.getAttribute('aria-description')).toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
