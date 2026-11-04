// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { setShortcutEnvironmentForTesting } from '@/client/lib/keyboard-shortcuts';
import { SessionTabBar } from './session-tab-bar';
it('provides one tab stop, arrow navigation with manual activation, and sibling close controls', async () => {
  setShortcutEnvironmentForTesting({ platform: 'other', runtime: 'browser' });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const select = vi.fn();
  const close = vi.fn();
  try {
    await act(() =>
      root.render(
        <SessionTabBar
          sessions={['Alpha', 'Beta', 'Gamma'].map((name) => ({
            id: name,
            name,
            status: 'IDLE',
            createdAt: new Date(0),
          }))}
          currentSessionId="Beta"
          onCreateSession={() => undefined}
          onSelectSession={select}
          onCloseSession={close}
        />
      )
    );
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map(({ tabIndex }) => tabIndex)).toEqual([-1, 0, -1]);
    const press = (key: string) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      );
    tabs[1]!.focus();
    await act(() => {
      press('ArrowRight');
    });
    expect(document.activeElement).toBe(tabs[2]);
    expect(select).not.toHaveBeenCalled();
    await act(() => {
      press('ArrowRight');
    });
    expect(document.activeElement).toBe(tabs[0]);
    await act(() => {
      press('End');
      press('Enter');
    });
    expect(select).toHaveBeenCalledWith('Gamma');
    await act(() => {
      press('Delete');
    });
    expect(close).toHaveBeenCalledWith('Gamma');
    const closeButton = container.querySelector('[aria-label="Close Gamma"]');
    expect(closeButton?.closest('[role="tab"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
    setShortcutEnvironmentForTesting(null);
  }
});
