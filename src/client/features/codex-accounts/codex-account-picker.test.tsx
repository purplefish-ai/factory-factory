// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CodexAccountPicker } from './codex-account-picker';

it('directs signed-out native and managed accounts to their own reconnect flows', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <CodexAccountPicker
          accounts={[
            {
              id: 'native',
              label: 'Personal',
              kind: 'NATIVE_DEFAULT',
              authenticated: false,
              enabled: true,
            },
            { id: 'work', label: 'Work', kind: 'MANAGED', authenticated: false, enabled: true },
          ]}
          onChange={vi.fn()}
        />
      )
    );
    await act(() =>
      container
        .querySelector('button')
        ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
    );
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(items.find((item) => item.textContent === 'Personal')?.getAttribute('title')).toContain(
      'ff codex login'
    );
    expect(items.find((item) => item.textContent === 'Work')?.getAttribute('title')).toBe(
      'Sign in from Settings'
    );
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
