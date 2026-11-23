// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { waitForReact } from '@/test-utils/react-act';
import { LazyQuickChatSheet } from './lazy-quick-chat-sheet';
import type { QuickChatScrollMemory } from './use-quick-chat-scroll';

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

const memories: QuickChatScrollMemory[] = [];
function LoadedBody({
  workspaceId,
  scrollMemory,
}: {
  workspaceId: string | null;
  scrollMemory: QuickChatScrollMemory;
}) {
  memories.push(scrollMemory);
  return <output data-testid="quick-chat">{workspaceId ?? 'closed'}</output>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('opens one sheet at once, loads the body inside it and keeps scroll memory across reopening', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const render = (workspaceId: string | null) =>
    act(() => root.render(<LazyQuickChatSheet workspaceId={workspaceId} onClose={onClose} />));
  const body = () => document.querySelector('[data-testid="quick-chat"]')?.textContent;
  try {
    await render(null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(chunk.requested).toBe(false);

    await render('w1');
    expect(chunk.requested).toBe(true);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Fix login');
    expect(dialog?.textContent).toContain('Loading chat…');

    await act(() => chunk.resolve({ QuickChatSheetBody: LoadedBody }));
    await waitForReact(() => expect(body()).toBe('w1'));
    // The loaded body replaces the placeholder inside the same sheet, so it does not slide in twice.
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog?.textContent).not.toContain('Loading chat…');

    await render(null);
    await waitForReact(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    await render('w1');
    await waitForReact(() => expect(body()).toBe('w1'));
    expect(new Set(memories).size).toBe(1);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
