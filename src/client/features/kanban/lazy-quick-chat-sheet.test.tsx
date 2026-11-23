// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { waitForReact } from '@/test-utils/react-act';
import { LazyQuickChatSheet } from './lazy-quick-chat-sheet';

const chunk = vi.hoisted(() => {
  let resolve: (module: unknown) => void = () => undefined;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve, requested: false };
});
vi.mock('./quick-chat-sheet', () => {
  chunk.requested = true;
  return chunk.promise;
});
vi.mock('./kanban-context', () => ({
  useKanbanState: () => ({ workspaces: [{ id: 'w1', name: 'Fix login' }] }),
}));

const mounts = vi.fn();
function LoadedQuickChatSheet({ workspaceId }: { workspaceId: string | null }) {
  useEffect(() => mounts(), []);
  return <output data-testid="quick-chat">{workspaceId ?? 'closed'}</output>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('loads Quick Chat on the first open behind a loading sheet and keeps it mounted after closing', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const render = (workspaceId: string | null) =>
    act(() => root.render(<LazyQuickChatSheet workspaceId={workspaceId} onClose={onClose} />));
  const loaded = () => document.querySelector('[data-testid="quick-chat"]')?.textContent;
  try {
    await render(null);
    expect(document.body.textContent).toBe('');
    expect(chunk.requested).toBe(false);

    await render('w1');
    expect(chunk.requested).toBe(true);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Fix login');
    expect(dialog?.textContent).toContain('Loading chat…');

    await act(() => chunk.resolve({ QuickChatSheet: LoadedQuickChatSheet }));
    await waitForReact(() => expect(loaded()).toBe('w1'));
    expect(document.body.textContent).not.toContain('Loading chat…');

    await render(null);
    expect(loaded()).toBe('closed');
    await render('w1');
    expect(loaded()).toBe('w1');
    expect(mounts).toHaveBeenCalledTimes(1);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
