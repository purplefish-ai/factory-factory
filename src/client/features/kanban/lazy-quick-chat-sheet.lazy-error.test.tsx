// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { waitForReact } from '@/test-utils/react-act';
import { LazyQuickChatSheet } from './lazy-quick-chat-sheet';

const chunk = vi.hoisted(() => {
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
});
vi.mock('./quick-chat-sheet', () => chunk.promise);
vi.mock('./kanban-context', () => ({
  useKanbanState: () => ({ workspaces: [{ id: 'w1', name: 'Fix login' }] }),
}));

it('contains a failed Quick Chat chunk in the sheet and keeps it closable', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('reportError', vi.fn());
  const container = document.createElement('div');
  document.body.append(container);
  const uncaught = vi.fn();
  const root = createRoot(container, { onCaughtError: () => undefined, onUncaughtError: uncaught });
  const onClose = vi.fn();
  const render = (workspaceId: string | null) =>
    act(() => root.render(<LazyQuickChatSheet workspaceId={workspaceId} onClose={onClose} />));
  try {
    await render('w1');
    await act(() => chunk.reject(new Error('Failed to fetch Quick Chat chunk')));
    await waitForReact(() =>
      expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
        "Couldn't load Quick Chat"
      )
    );
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    expect(buttons.map((button) => button.textContent)).toContain('Reload');
    expect(uncaught).not.toHaveBeenCalled();

    await act(() => buttons.find((button) => button.textContent === 'Close')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await render(null);
    await waitForReact(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
