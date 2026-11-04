// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { setShortcutEnvironmentForTesting } from '@/client/lib/keyboard-shortcuts';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  cleanupSubagentTabTestEnvironment,
  setupSubagentTabTestEnvironment,
} from '@/test-utils/subagent-tabs';
import { MainViewTabBar } from './main-view-tab-bar';
import { WorkspacePanelProvider } from './workspace-panel-context';

it('navigates chat tabs without nesting close controls or claiming browser Ctrl+Tab', async () => {
  setupSubagentTabTestEnvironment();
  setShortcutEnvironmentForTesting({ platform: 'other', runtime: 'browser' });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const select = vi.fn();
  const close = vi.fn();
  try {
    await act(() =>
      root.render(
        <TooltipProvider>
          <WorkspacePanelProvider workspaceId="keyboard-test">
            <MainViewTabBar
              workspaceId="keyboard-test"
              sessions={['Alpha', 'Beta'].map((name) => ({ id: name, name, status: 'IDLE' }))}
              currentSessionId="Alpha"
              onSelectSession={select}
              onCloseSession={close}
            />
          </WorkspacePanelProvider>
        </TooltipProvider>
      )
    );
    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map(({ tabIndex }) => tabIndex)).toEqual([0, -1]);
    expect(tabs.every((tab) => tab.querySelector('button') === null)).toBe(true);
    tabs[0]!.focus();
    await act(() => {
      tabs[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      );
    });
    expect(document.activeElement).toBe(tabs[1]);
    expect(select).not.toHaveBeenCalled();
    await act(() => {
      tabs[1]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });
    expect(select).toHaveBeenCalledWith('Beta');
    select.mockClear();
    const browserTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => {
      tabs[1]!.dispatchEvent(browserTab);
    });
    expect(browserTab.defaultPrevented).toBe(false);
    expect(select).not.toHaveBeenCalled();
  } finally {
    await act(() => root.unmount());
    container.remove();
    setShortcutEnvironmentForTesting(null);
    cleanupSubagentTabTestEnvironment();
  }
});

it.each([null, 'missing'])(
  'starts previous chat at the last tab for selection %s',
  async (currentSessionId) => {
    setupSubagentTabTestEnvironment();
    const root = createRoot(document.createElement('div'));
    const select = vi.fn();
    try {
      await act(() =>
        root.render(
          <TooltipProvider>
            <WorkspacePanelProvider workspaceId="keyboard-stale">
              <MainViewTabBar
                workspaceId="keyboard-stale"
                sessions={['Alpha', 'Beta', 'Gamma'].map((name) => ({
                  id: name,
                  name,
                  status: 'IDLE',
                }))}
                currentSessionId={currentSessionId}
                onSelectSession={select}
              />
            </WorkspacePanelProvider>
          </TooltipProvider>
        )
      );
      await act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '[',
            code: 'BracketLeft',
            altKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
      });
      expect(select).toHaveBeenCalledWith('Gamma');
    } finally {
      await act(() => root.unmount());
      cleanupSubagentTabTestEnvironment();
    }
  }
);
