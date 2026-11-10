// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setShortcutEnvironmentForTesting } from '@/client/lib/keyboard-shortcuts';
import { TabButton } from '@/components/ui/tab-button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TerminalTabBar } from './terminal-tab-bar';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setShortcutEnvironmentForTesting({ platform: 'other', runtime: 'browser' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  setShortcutEnvironmentForTesting(null);
  vi.unstubAllGlobals();
});

const press = (key: string) =>
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );

function Panel({ onSelect }: { onSelect: (id: string) => void }) {
  const [tabs, setTabs] = useState([
    { id: 'one', label: 'Terminal 1' },
    { id: 'two', label: 'Terminal 2' },
    { id: 'three', label: 'Terminal 3' },
  ]);
  return (
    <TooltipProvider>
      <TerminalTabBar
        tabs={tabs}
        activeTabId="two"
        onSelectTab={onSelect}
        onCloseTab={(id) => setTabs((items) => items.filter((tab) => tab.id !== id))}
        onNewTab={() => undefined}
        leadingTabs={<TabButton label="Logs" isActive={false} onSelect={() => onSelect('logs')} />}
      />
    </TooltipProvider>
  );
}

it('renders Logs and terminals as one tablist with a single Tab stop and arrow navigation', async () => {
  const select = vi.fn();
  await act(() => root.render(<Panel onSelect={select} />));

  const tablist = container.querySelector('[role="tablist"]');
  expect(tablist?.getAttribute('aria-label')).toBe('Logs and terminals');
  const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    'Logs',
    'Terminal 1',
    'Terminal 2',
    'Terminal 3',
  ]);
  expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual([
    'false',
    'false',
    'true',
    'false',
  ]);
  expect(tabs.map(({ tabIndex }) => tabIndex)).toEqual([-1, -1, 0, -1]);
  // The new-terminal button has a name and sits outside the tablist.
  const newTerminal = container.querySelector('[aria-label="New terminal"]');
  expect(newTerminal?.closest('[role="tablist"]')).toBeNull();
  // Close buttons are siblings of their tab, never inside it.
  expect(container.querySelector('[aria-label="Close Terminal 2"]')?.closest('[role="tab"]')).toBe(
    null
  );

  tabs[2]!.focus();
  await act(() => {
    press('ArrowRight');
  });
  expect(document.activeElement).toBe(tabs[3]);
  expect(select).not.toHaveBeenCalled();
  await act(() => {
    press('ArrowRight');
  });
  expect(document.activeElement).toBe(tabs[0]);
  await act(() => {
    press('End');
  });
  expect(document.activeElement).toBe(tabs[3]);
  await act(() => {
    press('Home');
  });
  expect(document.activeElement).toBe(tabs[0]);
  await act(() => {
    press('ArrowLeft');
  });
  expect(document.activeElement).toBe(tabs[3]);
  expect(tabs.map(({ tabIndex }) => tabIndex)).toEqual([-1, -1, -1, 0]);
  await act(() => {
    press('Enter');
  });
  expect(select).toHaveBeenCalledWith('three');
});

it('closes the focused terminal with Delete and keeps focus in the tab bar', async () => {
  await act(() => root.render(<Panel onSelect={() => undefined} />));
  const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(tabs[3]?.getAttribute('aria-keyshortcuts')).toBe('Delete');
  // Logs cannot be closed, so it does not advertise the shortcut.
  expect(tabs[0]?.hasAttribute('aria-keyshortcuts')).toBe(false);

  tabs[3]!.focus();
  await act(() => {
    press('Delete');
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(container.textContent).not.toContain('Terminal 3');
  expect(document.activeElement).toBe(tabs[2]);
  expect(tabs[2]?.tabIndex).toBe(0);
});
