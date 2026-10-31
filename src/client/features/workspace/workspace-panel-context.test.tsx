// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSelection } from '@/client/features/subagents';
import { actFlushSync } from '@/test-utils/react-act';
import {
  type MainViewTab,
  useWorkspacePanel,
  WorkspacePanelProvider,
} from './workspace-panel-context';

const viewport = vi.hoisted(() => ({ mobile: false }));

vi.mock('@/hooks/use-mobile', () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => viewport.mobile,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

const WORKSPACE_ID = 'workspace-1';
const TABS_STORAGE_KEY = `workspace-panel-tabs-${WORKSPACE_ID}`;
const ACTIVE_TAB_STORAGE_KEY = `workspace-panel-active-tab-${WORKSPACE_ID}`;

function PanelScrollProbe({
  onPanel,
}: {
  onPanel: (panel: ReturnType<typeof useWorkspacePanel>) => void;
}) {
  onPanel(useWorkspacePanel());
  return null;
}

function WorkspacePanelProbe() {
  const { activeTabId, tabs } = useWorkspacePanel();
  return createElement('output', null, JSON.stringify({ activeTabId, tabs }));
}

const runningSelection: SubagentSelection = {
  parentSessionId: 'session-1',
  parentSessionName: 'Chat 1',
  subagent: {
    id: 'child-1',
    name: 'Security review',
    status: 'running',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:01:00.000Z',
    completedAt: null,
    latestActivity: 'Inspecting auth',
    resultPreview: null,
  },
};

function WorkspacePanelActionsProbe() {
  const { activeTabId, tabs, openTab, openSubagentTab, updateSubagentTab, closeTab, selectTab } =
    useWorkspacePanel();
  return (
    <>
      <button type="button" onClick={() => openTab('screenshot', '/tmp/capture.png', 'Capture')}>
        Open screenshot
      </button>
      <button type="button" onClick={() => openSubagentTab(runningSelection)}>
        Open running
      </button>
      <button
        type="button"
        onClick={() =>
          openSubagentTab({
            ...runningSelection,
            parentSessionId: 'session-2',
            parentSessionName: 'Chat 2',
          })
        }
      >
        Open same child under another parent
      </button>
      <button
        type="button"
        onClick={() =>
          updateSubagentTab({
            ...runningSelection,
            subagent: {
              ...runningSelection.subagent,
              name: 'Completed security review',
              status: 'completed',
              completedAt: '2026-08-10T10:05:00.000Z',
            },
          })
        }
      >
        Complete
      </button>
      <button type="button" onClick={() => selectTab('chat')}>
        Select chat
      </button>
      <button type="button" onClick={() => closeTab(activeTabId)}>
        Close active
      </button>
      <output>{JSON.stringify({ activeTabId, tabs })}</output>
    </>
  );
}

function renderPanel(probe: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  actFlushSync(() => {
    root.render(
      <WorkspacePanelProvider workspaceId={WORKSPACE_ID}>{probe}</WorkspacePanelProvider>
    );
  });

  return { container, root };
}

async function clickButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  );
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function readProbe(container: HTMLElement): { activeTabId: string; tabs: MainViewTab[] } {
  const output = container.querySelector('output');
  if (!output) {
    throw new Error('Panel probe output not found');
  }
  return JSON.parse(output.textContent ?? '');
}

beforeEach(() => {
  localStorage.clear();
  viewport.mobile = false;
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('WorkspacePanelProvider persistence', () => {
  it('dismisses the drawer when opening a file or diff in the main view', async () => {
    viewport.mobile = true;
    let state: ReturnType<typeof useWorkspacePanel> | undefined;
    const panel = renderPanel(
      <PanelScrollProbe
        onPanel={(value) => {
          state = value;
        }}
      />
    );
    await act(() => state!.setRightPanelVisible(true));
    expect(state!.rightPanelVisible).toBe(true);
    await act(() => state!.openTab('diff', 'src/app.tsx'));
    expect(state!.rightPanelVisible).toBe(false);
    expect(state!.activeTabId).toBe('diff-src/app.tsx');
    await act(() => panel.root.unmount());
  });

  it('reactivates an open screenshot without duplicating its tab', async () => {
    let panel: ReturnType<typeof renderPanel>;
    await act(() => {
      panel = renderPanel(<WorkspacePanelActionsProbe />);
    });
    await clickButton(panel!.container, 'Open screenshot');
    await clickButton(panel!.container, 'Select chat');
    expect(readProbe(panel!.container).activeTabId).toBe('chat');
    await clickButton(panel!.container, 'Open screenshot');
    expect(readProbe(panel!.container).activeTabId).toBe('screenshot-/tmp/capture.png');
    expect(readProbe(panel!.container).tabs).toHaveLength(2);
    expect(
      readProbe(panel!.container).tabs.filter((tab) => tab.type === 'screenshot')
    ).toHaveLength(1);
    await clickButton(panel!.container, 'Close active');
    expect(readProbe(panel!.container).tabs).toEqual([{ id: 'chat', type: 'chat', label: 'Chat' }]);
    await act(() => panel!.root.unmount());
  });

  it('retains the screenshot path when opening and restoring its tab', async () => {
    let panel: ReturnType<typeof renderPanel>;
    await act(() => {
      panel = renderPanel(<WorkspacePanelActionsProbe />);
    });
    const { container, root } = panel!;
    await clickButton(container, 'Open screenshot');
    const screenshotTab: MainViewTab = {
      id: 'screenshot-/tmp/capture.png',
      type: 'screenshot',
      path: '/tmp/capture.png',
      label: 'Capture',
    };
    expect(readProbe(container).tabs).toContainEqual(screenshotTab);
    expect(readProbe(container).activeTabId).toBe(screenshotTab.id);
    expect(JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) ?? '[]')).toContainEqual(
      screenshotTab
    );
    await act(() => root.unmount());

    await act(() => {
      panel = renderPanel(<WorkspacePanelProbe />);
    });
    expect(readProbe(panel!.container).tabs).toContainEqual(screenshotTab);
    expect(readProbe(panel!.container).activeTabId).toBe(screenshotTab.id);
    await act(() => panel!.root.unmount());
  });

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

    actFlushSync(() => {
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

    actFlushSync(() => root.unmount());
  });

  it('opens, deduplicates, refreshes, and closes a persisted sub-agent tab', async () => {
    const { container, root } = renderPanel(<WorkspacePanelActionsProbe />);

    await clickButton(container, 'Open running');
    await clickButton(container, 'Open running');
    await vi.waitFor(() => {
      const state = readProbe(container);
      expect(state.tabs.filter((tab) => tab.type === 'subagent')).toHaveLength(1);
      expect(state.activeTabId).toBe('subagent-session-1-child-1');
    });

    await clickButton(container, 'Complete');
    await vi.waitFor(() => {
      const tab = readProbe(container).tabs.find((candidate) => candidate.type === 'subagent');
      expect(tab).toEqual(
        expect.objectContaining({
          id: 'subagent-session-1-child-1',
          label: 'Completed security review',
          subagentSelection: expect.objectContaining({
            subagent: expect.objectContaining({ status: 'completed' }),
          }),
        })
      );
      expect(JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) ?? '[]')).toContainEqual(tab);
    });

    await clickButton(container, 'Close active');
    expect(readProbe(container).activeTabId).toBe('chat');
    expect(readProbe(container).tabs).toHaveLength(1);
    actFlushSync(() => root.unmount());
  });

  it('keeps equal child IDs under different parent sessions distinct', async () => {
    const { container, root } = renderPanel(<WorkspacePanelActionsProbe />);
    await clickButton(container, 'Open running');
    await clickButton(container, 'Open same child under another parent');
    await vi.waitFor(() => {
      expect(readProbe(container).tabs.map((tab) => tab.id)).toEqual([
        'chat',
        'subagent-session-1-child-1',
        'subagent-session-2-child-1',
      ]);
    });
    actFlushSync(() => root.unmount());
  });

  it('restores a valid persisted sub-agent tab and rejects an incomplete one', async () => {
    const validTab: MainViewTab = {
      id: 'subagent-session-1-child-1',
      type: 'subagent',
      label: 'Security review',
      subagentSelection: runningSelection,
    };
    localStorage.setItem(
      TABS_STORAGE_KEY,
      JSON.stringify([{ id: 'chat', type: 'chat', label: 'Chat' }, validTab])
    );
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, validTab.id);
    const validRender = renderPanel(<WorkspacePanelProbe />);
    await vi.waitFor(() => expect(readProbe(validRender.container).activeTabId).toBe(validTab.id));
    actFlushSync(() => validRender.root.unmount());

    localStorage.setItem(
      TABS_STORAGE_KEY,
      JSON.stringify([
        { id: 'chat', type: 'chat', label: 'Chat' },
        { id: 'subagent-broken', type: 'subagent', label: 'Broken' },
      ])
    );
    const invalidRender = renderPanel(<WorkspacePanelProbe />);
    await vi.waitFor(() =>
      expect(readProbe(invalidRender.container).tabs).toEqual([
        { id: 'chat', type: 'chat', label: 'Chat' },
      ])
    );
    actFlushSync(() => invalidRender.root.unmount());
  });
});

it('revokes only the cleared tab writer and preserves other viewer records', async () => {
  vi.useFakeTimers();
  let panel: ReturnType<typeof useWorkspacePanel> | undefined;
  const { root } = renderPanel(
    <PanelScrollProbe
      onPanel={(value) => {
        panel = value;
      }}
    />
  );
  const writeA = panel!.createScrollStateWriter('chat-a', 'chat');
  const writeB = panel!.createScrollStateWriter('chat-b', 'chat');
  actFlushSync(() => {
    panel!.setScrollState('file', 'code', {
      top: 70,
      left: 10,
      diffAnchor: { index: 3, offset: 2 },
    });
    writeA({ top: 10, left: 0 });
    writeB({ top: 20, left: 0 });
    panel!.clearScrollState('chat-b');
    writeB({ top: 99, left: 0 });
    writeA({ top: 11, left: 0 });
    vi.advanceTimersByTime(120);
  });
  const payload = JSON.parse(
    localStorage.getItem(`workspace-panel-scroll-${WORKSPACE_ID}`) ?? '{}'
  );
  expect(payload).toEqual({
    v: 1,
    states: {
      'file:code': { top: 70, left: 10, diffAnchor: { index: 3, offset: 2 } },
      'chat-a:chat': { top: 11, left: 0 },
    },
  });
  await act(() => root.unmount());
  vi.useRealTimers();
});
