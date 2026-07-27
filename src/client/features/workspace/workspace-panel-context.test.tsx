// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type MainViewTab,
  useWorkspacePanel,
  WorkspacePanelProvider,
} from './workspace-panel-context';

vi.mock('@/hooks/use-mobile', () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => false,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

const WORKSPACE_ID = 'workspace-1';
const TABS_STORAGE_KEY = `workspace-panel-tabs-${WORKSPACE_ID}`;
const ACTIVE_TAB_STORAGE_KEY = `workspace-panel-active-tab-${WORKSPACE_ID}`;

function WorkspacePanelProbe() {
  const { activeTabId, tabs } = useWorkspacePanel();
  return createElement('output', null, JSON.stringify({ activeTabId, tabs }));
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('WorkspacePanelProvider persistence', () => {
  it('restores mixed tabs when a closed-session tab is stored', async () => {
    const storedTabs: MainViewTab[] = [
      { id: 'chat', type: 'chat', label: 'Chat' },
      { id: 'file-src/index.ts', type: 'file', path: 'src/index.ts', label: 'index.ts' },
      {
        id: 'closed-session-session-1',
        type: 'closed-session',
        closedSessionId: 'session-1',
        label: 'History',
      },
    ];
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(storedTabs));
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, 'closed-session-session-1');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        <WorkspacePanelProvider workspaceId={WORKSPACE_ID}>
          <WorkspacePanelProbe />
        </WorkspacePanelProvider>
      );
    });

    await vi.waitFor(() => {
      expect(JSON.parse(container.textContent ?? '')).toEqual({
        activeTabId: 'closed-session-session-1',
        tabs: storedTabs,
      });
    });

    flushSync(() => {
      root.unmount();
    });
  });
});
