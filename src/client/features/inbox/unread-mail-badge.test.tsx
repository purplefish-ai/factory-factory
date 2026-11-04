// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnreadMailBadge } from './unread-mail-badge';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('shows unread mail as an accessible icon and count, hides zero, and caps only the visual count', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<UnreadMailBadge count={3} />));
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '3 unread inbox messages'
    );
    expect(container.textContent).toBe('3');
    await act(() => root.render(<UnreadMailBadge count={125} />));
    expect(container.textContent).toBe('99+');
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      '125 unread inbox messages'
    );
    await act(() => root.render(<UnreadMailBadge count={0} />));
    expect(container.innerHTML).toBe('');
  } finally {
    await act(() => root.unmount());
  }
});
