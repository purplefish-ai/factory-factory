// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { setShortcutEnvironmentForTesting } from '@/client/lib/keyboard-shortcuts';
import { SessionTabBar } from './session-tab-bar';
it('provides one tab stop, arrow navigation with manual activation, and sibling close controls', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
    expect(tabs.map(({ tabIndex }) => tabIndex)).toEqual([-1, -1, 0]);
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
    vi.unstubAllGlobals();
  }
});

function ClosingChats() {
  const [names, setNames] = useState(['Alpha', 'Beta']);
  return (
    <SessionTabBar
      sessions={names.map((name) => ({ id: name, name, status: 'IDLE', createdAt: new Date(0) }))}
      currentSessionId="Alpha"
      onCreateSession={() => undefined}
      onSelectSession={() => undefined}
      onCloseSession={(id) => setNames((items) => items.filter((name) => name !== id))}
    />
  );
}

it('keeps keyboard focus in the chat bar after deleting the focused tab', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setShortcutEnvironmentForTesting({ platform: 'other', runtime: 'browser' });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<ClosingChats />));
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    tabs[1]!.focus();
    await act(() => {
      tabs[1]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      );
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0]?.tabIndex).toBe(0);
  } finally {
    await act(() => root.unmount());
    container.remove();
    setShortcutEnvironmentForTesting(null);
    vi.unstubAllGlobals();
  }
});

it('moves focus to an enabled neighbor when the focused tab becomes disabled', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<ClosingChats />));
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    tabs[1]!.focus();
    await act(() => {
      tabs[1]!.setAttribute('aria-disabled', 'true');
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0]?.tabIndex).toBe(0);
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
