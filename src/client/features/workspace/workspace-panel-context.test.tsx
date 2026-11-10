// @vitest-environment jsdom

import { act, createElement, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSelection } from '@/client/features/subagents';
import { actFlushSync } from '@/test-utils/react-act';
import {
  type MainViewTab,
  useWorkspacePanel,
  useWorkspacePanelActions,
  useWorkspacePanelScroll,
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
const CHAT_TAB_RECORD: MainViewTab = { id: 'chat', type: 'chat', label: 'Chat' };

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
    stopControl: { controlId: 'live-control', runtimeId: 'live-runtime' },
  },
};

function IdentityProbe() {
  const { tabs, openSubagentTab, updateSubagentTab } = useWorkspacePanel();
  const current = tabs.find((tab) => tab.type === 'subagent')?.subagentSelection;
  return (
    <>
      <button type="button" onClick={() => openSubagentTab(runningSelection)}>
        Open live
      </button>
      <button type="button" onClick={() => updateSubagentTab(runningSelection)}>
        Refresh live
      </button>
      <output>
        {current?.subagent === runningSelection.subagent ? 'same live object' : 'different object'}
      </output>
    </>
  );
}

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
  it('renders stored panel state on its first render without writing storage', () => {
    const fileTab: MainViewTab = {
      id: 'file-src/a.ts',
      type: 'file',
      path: 'src/a.ts',
      label: 'a.ts',
    };
    const stored = {
      [TABS_STORAGE_KEY]: JSON.stringify([CHAT_TAB_RECORD, fileTab]),
      [ACTIVE_TAB_STORAGE_KEY]: fileTab.id,
      [`workspace-panel-bottom-tab-${WORKSPACE_ID}`]: 'dev-logs',
      [`workspace-panel-right-visible-${WORKSPACE_ID}`]: 'false',
      [`workspace-right-panel-tab-${WORKSPACE_ID}`]: 'files',
    };
    for (const [key, value] of Object.entries(stored)) {
      localStorage.setItem(key, value);
    }
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const renders: Pick<
      ReturnType<typeof useWorkspacePanel>,
      'activeTabId' | 'activeBottomTab' | 'storedTopTab' | 'rightPanelVisible' | 'tabs'
    >[] = [];
    const { root } = renderPanel(
      <PanelScrollProbe
        onPanel={({ activeTabId, activeBottomTab, storedTopTab, rightPanelVisible, tabs }) => {
          renders.push({ activeTabId, activeBottomTab, storedTopTab, rightPanelVisible, tabs });
        }}
      />
    );
    try {
      expect(renders[0]).toEqual({
        activeTabId: fileTab.id,
        activeBottomTab: 'dev-logs',
        storedTopTab: 'files',
        rightPanelVisible: false,
        tabs: [CHAT_TAB_RECORD, fileTab],
      });
      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      for (const [key, value] of Object.entries(stored)) {
        expect(localStorage.getItem(key)).toBe(value);
      }
    } finally {
      setItem.mockRestore();
      removeItem.mockRestore();
      actFlushSync(() => root.unmount());
    }
  });

  it('opens a linked chat without rewriting the stored tab until the user selects one', async () => {
    const fileTab: MainViewTab = {
      id: 'file-src/a.ts',
      type: 'file',
      path: 'src/a.ts',
      label: 'a.ts',
    };
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify([CHAT_TAB_RECORD, fileTab]));
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, fileTab.id);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    actFlushSync(() => {
      root.render(
        <WorkspacePanelProvider workspaceId={WORKSPACE_ID} initialActiveTabId="chat">
          <WorkspacePanelActionsProbe />
        </WorkspacePanelProvider>
      );
    });
    expect(readProbe(container).activeTabId).toBe('chat');
    expect(localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)).toBe(fileTab.id);
    await clickButton(container, 'Select chat');
    expect(localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)).toBe('chat');
    actFlushSync(() => root.unmount());
  });

  it('reads the legacy bottom tab key until a tab is chosen', async () => {
    localStorage.setItem(`workspace-right-panel-bottom-tab-${WORKSPACE_ID}`, 'dev-logs');
    let panel: ReturnType<typeof useWorkspacePanel> | undefined;
    const { root } = renderPanel(
      <PanelScrollProbe
        onPanel={(value) => {
          panel = value;
        }}
      />
    );
    expect(panel!.activeBottomTab).toBe('dev-logs');
    await act(() => panel!.setActiveBottomTab('setup-logs'));
    expect(panel!.activeBottomTab).toBe('setup-logs');
    expect(localStorage.getItem(`workspace-panel-bottom-tab-${WORKSPACE_ID}`)).toBe('setup-logs');
    actFlushSync(() => root.unmount());
  });

  it('keeps the mobile drawer closed and out of storage', async () => {
    viewport.mobile = true;
    localStorage.setItem(`workspace-panel-right-visible-${WORKSPACE_ID}`, 'true');
    let panel: ReturnType<typeof useWorkspacePanel> | undefined;
    const { root } = renderPanel(
      <PanelScrollProbe
        onPanel={(value) => {
          panel = value;
        }}
      />
    );
    expect(panel!.rightPanelVisible).toBe(false);
    await act(() => panel!.setRightPanelVisible(true));
    expect(panel!.rightPanelVisible).toBe(true);
    await act(() => panel!.openTab('file', 'src/a.ts'));
    expect(panel!.rightPanelVisible).toBe(false);
    expect(localStorage.getItem(`workspace-panel-right-visible-${WORKSPACE_ID}`)).toBe('true');
    actFlushSync(() => root.unmount());
  });

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

    expect(localStorage.getItem(TABS_STORAGE_KEY)).not.toContain('live-control');
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
      expect(JSON.parse(localStorage.getItem(TABS_STORAGE_KEY) ?? '[]')).toContainEqual({
        ...tab,
        subagentSelection: {
          ...tab?.subagentSelection,
          subagent: { ...tab?.subagentSelection?.subagent, stopControl: undefined },
        },
      });
      expect(localStorage.getItem(TABS_STORAGE_KEY)).not.toContain('live-control');
    });

    await clickButton(container, 'Close active');
    expect(readProbe(container).activeTabId).toBe('chat');
    expect(readProbe(container).tabs).toHaveLength(1);
    actFlushSync(() => root.unmount());
  });

  it('preserves live summary identity while sanitizing the persisted snapshot', async () => {
    const { container, root } = renderPanel(<IdentityProbe />);
    await clickButton(container, 'Open live');
    expect(container.querySelector('output')?.textContent).toBe('same live object');
    await clickButton(container, 'Refresh live');
    expect(container.querySelector('output')?.textContent).toBe('same live object');
    expect(localStorage.getItem(TABS_STORAGE_KEY)).not.toContain('live-control');
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

  it.each([
    ['', 'Sub-agent child-1', 'Subagent child-1'],
    ['Sub-agent child-1', 'Sub-agent child-1', 'Sub-agent child-1'],
    ['', 'Sub-agent custom label', 'Sub-agent custom label'],
  ])(
    'normalizes only generated unnamed legacy tab labels (name=%s label=%s)',
    async (name, label, expected) => {
      const tab: MainViewTab = {
        id: 'subagent-session-1-child-1',
        type: 'subagent',
        label,
        subagentSelection: {
          ...runningSelection,
          subagent: { ...runningSelection.subagent, name },
        },
      };
      localStorage.setItem(
        TABS_STORAGE_KEY,
        JSON.stringify([{ id: 'chat', type: 'chat', label: 'Chat' }, tab])
      );
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab.id);
      const view = renderPanel(<WorkspacePanelProbe />);
      try {
        await vi.waitFor(() => expect(readProbe(view.container).activeTabId).toBe(tab.id));
        expect(
          readProbe(view.container).tabs.find((candidate) => candidate.id === tab.id)?.label
        ).toBe(expected);
      } finally {
        actFlushSync(() => view.root.unmount());
      }
    }
  );

  it('restores a valid persisted sub-agent tab and rejects an incomplete one', async () => {
    const validTab: MainViewTab = {
      id: 'subagent-session-1-child-1',
      type: 'subagent',
      label: 'Security review',
      subagentSelection: runningSelection,
    };
    const storedTabs = JSON.stringify([{ id: 'chat', type: 'chat', label: 'Chat' }, validTab]);
    localStorage.setItem(TABS_STORAGE_KEY, storedTabs);
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, validTab.id);
    const validRender = renderPanel(<WorkspacePanelProbe />);
    await vi.waitFor(() => expect(readProbe(validRender.container).activeTabId).toBe(validTab.id));
    const restored = readProbe(validRender.container).tabs.find((tab) => tab.id === validTab.id);
    // The live control is dropped on read; restoring alone does not rewrite storage.
    expect(restored?.subagentSelection?.subagent.stopControl).toBeUndefined();
    expect(localStorage.getItem(TABS_STORAGE_KEY)).toBe(storedTabs);
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

const renderCounts = { actions: 0, scroll: 0 };
const actionIdentities = {
  openTab: new Set<unknown>(),
  closeTab: new Set<unknown>(),
  toggle: new Set<unknown>(),
};
const ActionsConsumer = memo(function ActionsConsumer() {
  renderCounts.actions += 1;
  useWorkspacePanelActions();
  return null;
});
const ScrollConsumer = memo(function ScrollConsumer() {
  renderCounts.scroll += 1;
  useWorkspacePanelScroll();
  return null;
});
function StateAndActionsProbe() {
  const { openTab, closeTab, toggleRightPanel } = useWorkspacePanel();
  actionIdentities.openTab.add(openTab);
  actionIdentities.closeTab.add(closeTab);
  actionIdentities.toggle.add(toggleRightPanel);
  return (
    <button type="button" onClick={toggleRightPanel}>
      Toggle panel
    </button>
  );
}

it('keeps actions stable and leaves action and scroll consumers alone on tab and panel changes', async () => {
  renderCounts.actions = 0;
  renderCounts.scroll = 0;
  for (const identities of Object.values(actionIdentities)) {
    identities.clear();
  }
  const { container, root } = renderPanel(
    <>
      <WorkspacePanelActionsProbe />
      <StateAndActionsProbe />
      <ActionsConsumer />
      <ScrollConsumer />
    </>
  );
  await clickButton(container, 'Open screenshot');
  await clickButton(container, 'Select chat');
  await clickButton(container, 'Toggle panel');
  await clickButton(container, 'Open running');
  await clickButton(container, 'Close active');
  expect(readProbe(container).activeTabId).toBe('screenshot-/tmp/capture.png');
  expect(renderCounts).toEqual({ actions: 1, scroll: 1 });
  expect([...Object.values(actionIdentities)].map((identities) => identities.size)).toEqual([
    1, 1, 1,
  ]);
  await act(() => root.unmount());
});
