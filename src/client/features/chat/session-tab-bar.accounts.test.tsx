// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SessionTabBar } from './session-tab-bar';

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    codexAccounts: {
      list: {
        useQuery: () => ({
          data: [
            { id: 'native', label: 'Personal', authenticated: true },
            { id: 'work', label: 'Work', authenticated: true },
          ],
        }),
      },
    },
  },
}));

it('keeps named account selection available for an empty Codex workspace', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onCreate = vi.fn();
  try {
    await act(() =>
      root.render(
        <SessionTabBar
          sessions={[]}
          workspaceProvider="CODEX"
          currentSessionId={null}
          onSelectSession={vi.fn()}
          onCreateSession={onCreate}
          onCloseSession={vi.fn()}
        />
      )
    );
    await act(() =>
      container
        .querySelector('button')
        ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    );
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(['Auto', 'Personal', 'Work']);
    await act(() => items.find((item) => item.textContent === 'Work')?.click());
    expect(onCreate).toHaveBeenCalledWith('work');
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
