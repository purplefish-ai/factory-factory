// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NewSessionAccountAction, NewSessionAccountActionView } from './new-session-account-action';

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    codexAccounts: {
      list: { useQuery: () => ({ data: undefined, error: new Error('Local only') }) },
    },
  },
}));
it('offers Auto and every authenticated account when launching another Codex chat', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onCreate = vi.fn();
  try {
    flushSync(() =>
      root.render(
        createElement(NewSessionAccountActionView, {
          onCreate,
          accounts: [
            { id: 'a', label: 'Personal', authenticated: true },
            { id: 'b', label: 'Work', authenticated: true },
          ],
        })
      )
    );
    flushSync(() =>
      container
        .querySelector('button')
        ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    );
    const work = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Work'
    );
    expect(work).toBeDefined();
    flushSync(() => work?.click());
    expect(onCreate).toHaveBeenLastCalledWith('b');
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
});
it('keeps single-account and Claude launches as one click with Auto', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onCreate = vi.fn();
  try {
    flushSync(() => root.render(createElement(NewSessionAccountActionView, { onCreate })));
    flushSync(() => container.querySelector('button')?.click());
    expect(onCreate).toHaveBeenCalledWith(undefined);
  } finally {
    flushSync(() => root.unmount());
  }
});

it('preserves remote new-chat compatibility when local account management is unavailable', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onCreate = vi.fn();
  try {
    flushSync(() =>
      root.render(createElement(NewSessionAccountAction, { provider: 'CODEX', onCreate }))
    );
    flushSync(() => container.querySelector('button')?.click());
    expect(onCreate).toHaveBeenCalledWith(undefined);
  } finally {
    flushSync(() => root.unmount());
  }
});
