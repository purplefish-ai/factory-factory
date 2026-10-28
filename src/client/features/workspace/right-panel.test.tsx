// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanel } from './right-panel';
import { useWorkspacePanel, WorkspacePanelProvider } from './workspace-panel-context';

const mocks = vi.hoisted(() => ({
  agentsProps: vi.fn(),
  workspaceData: undefined as
    | undefined
    | { mode: string; periodicTaskId: string | null; creationSource: string },
}));

vi.mock('@phosphor-icons/react/dist/csr/ArrowsClockwise', () => ({
  ArrowsClockwiseIcon: () => null,
}));
vi.mock('@phosphor-icons/react/dist/csr/Calendar', () => ({ CalendarIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/Camera', () => ({ CameraIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/FileDashed', () => ({ FileDashedIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/Files', () => ({ FilesIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/ListChecks', () => ({ ListChecksIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/Plus', () => ({ PlusIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/Terminal', () => ({ TerminalIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/TreeStructure', () => ({ TreeStructureIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/X', () => ({ XIcon: () => null }));

vi.mock('@/client/hooks/use-workspace-detail-query', () => ({
  useWorkspaceDetailQuery: () => ({ data: mocks.workspaceData }),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      getInitStatus: { useQuery: () => ({ data: { status: 'READY' } }) },
    },
  },
}));

vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => createElement('div'),
  ResizablePanel: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ResizablePanelGroup: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
}));

vi.mock('@/components/ui/tab-button', () => ({
  TabButton: ({
    label,
    isActive,
    onSelect,
  }: {
    label: string;
    isActive: boolean;
    onSelect: () => void;
  }) => createElement('button', { 'aria-pressed': isActive, onClick: onSelect }, label),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TooltipContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TooltipProvider: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TooltipTrigger: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));

vi.mock('./use-log-stream', () => ({
  useLogStream: () => ({
    connected: false,
    hasDisconnected: false,
    output: '',
    outputEndRef: { current: null },
  }),
}));

vi.mock('./agents-panel', () => ({
  AgentsPanel: (props: {
    workspaceId: string;
    sessionId: string | null;
    sessionName: string | null;
    sessionReady: boolean;
    isParentWorkspace: boolean;
  }) => {
    mocks.agentsProps(props);
    return createElement(
      'div',
      {
        'data-testid': 'agents-panel',
        'data-session': props.sessionId,
        'data-ready': props.sessionReady,
        'data-parent': props.isParentWorkspace,
      },
      [
        createElement('section', { key: 'provider', 'data-testid': 'provider-subagents' }),
        props.isParentWorkspace
          ? createElement('section', { key: 'children', 'data-testid': 'child-workspaces' })
          : null,
      ]
    );
  },
}));

vi.mock('./auto-iteration-panel', () => ({
  AutoIterationPanel: () => createElement('div', { 'data-testid': 'auto-iteration-panel' }),
}));
vi.mock('./combined-changes-panel', () => ({
  CombinedChangesPanel: () => createElement('div', { 'data-testid': 'changes-panel' }),
}));
vi.mock('./dev-logs-panel', () => ({ DevLogsPanel: () => null }));
vi.mock('./file-browser-panel', () => ({ FileBrowserPanel: () => null }));
vi.mock('./periodic-task-panel', () => ({
  PeriodicTaskPanel: () => createElement('div', { 'data-testid': 'periodic-task-panel' }),
}));
vi.mock('./screenshots-panel', () => ({ ScreenshotsPanel: () => null }));
vi.mock('./setup-logs-panel', () => ({ SetupLogsPanel: () => null }));
vi.mock('./todo-panel-container', () => ({ TodoPanelContainer: () => null }));

vi.mock('./terminal-panel', () => ({
  TerminalPanel: () => null,
}));

vi.mock('./terminal-tab-bar', () => ({
  TerminalTabBar: () => null,
}));

function Navigation() {
  const { rightPanelVisible, setRightPanelVisible, setActiveTopTab } = useWorkspacePanel();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setActiveTopTab('agents');
          setRightPanelVisible(true);
        }}
      >
        Open agents
      </button>
      <button type="button" onClick={() => setRightPanelVisible(false)}>
        Close panel
      </button>
      {rightPanelVisible && <RightPanel workspaceId="workspace-1" />}
    </>
  );
}

describe('RightPanel Agents tab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    localStorage.clear();
    mocks.workspaceData = {
      mode: 'STANDARD',
      periodicTaskId: null,
      creationSource: 'MANUAL',
    };
    mocks.agentsProps.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    void act(() => root.unmount());
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function render(workspaceId = 'workspace-1') {
    void act(() =>
      root.render(
        <WorkspacePanelProvider workspaceId={workspaceId}>
          <RightPanel
            workspaceId={workspaceId}
            selectedSessionId="session-1"
            selectedSessionName="Session 1"
            selectedSessionReady
            onOpenSubagent={vi.fn()}
          />
        </WorkspacePanelProvider>
      )
    );
  }

  it('selects Agents from outside the panel and preserves it when the panel remounts', () => {
    void act(() =>
      root.render(
        <WorkspacePanelProvider workspaceId="workspace-1">
          <Navigation />
        </WorkspacePanelProvider>
      )
    );
    expect(container.querySelector('[data-testid="agents-panel"]')).toBeNull();
    void act(() => container.querySelector('button')?.click());
    expect(container.querySelector('[data-testid="agents-panel"]')).not.toBeNull();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('agents');
    void act(() => container.querySelectorAll('button')[1]?.click());
    expect(container.querySelector('[data-testid="agents-panel"]')).toBeNull();
    void act(() => container.querySelector('button')?.click());
    expect(container.querySelector('[data-testid="agents-panel"]')).not.toBeNull();
  });

  it.each(['periodic-task', 'auto-iteration'])(
    'falls back from unavailable persisted %s tab',
    (tab) => {
      localStorage.setItem('workspace-right-panel-tab-workspace-1', tab);
      render();
      expect(container.querySelector('[data-testid="changes-panel"]')).not.toBeNull();
      expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('changes');
      expect(
        [...container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Changes')
          ?.getAttribute('aria-pressed')
      ).toBe('true');
    }
  );

  it('waits for workspace capabilities before rejecting a periodic-task preference', () => {
    localStorage.setItem('workspace-right-panel-tab-workspace-1', 'periodic-task');
    mocks.workspaceData = undefined;
    render();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('periodic-task');
    mocks.workspaceData = { mode: 'STANDARD', periodicTaskId: 'task-1', creationSource: 'MANUAL' };
    render();
    expect(container.querySelector('[data-testid="periodic-task-panel"]')).not.toBeNull();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('periodic-task');
  });

  it('falls back when an open workspace loses its periodic task', () => {
    localStorage.setItem('workspace-right-panel-tab-workspace-1', 'periodic-task');
    mocks.workspaceData = { mode: 'STANDARD', periodicTaskId: 'task-1', creationSource: 'MANUAL' };
    render();
    expect(container.querySelector('[data-testid="periodic-task-panel"]')).not.toBeNull();
    mocks.workspaceData = { mode: 'STANDARD', periodicTaskId: null, creationSource: 'MANUAL' };
    render();
    expect(container.querySelector('[data-testid="changes-panel"]')).not.toBeNull();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('changes');
  });

  it('preserves another workspace preference when switching from a periodic task', () => {
    localStorage.setItem('workspace-right-panel-tab-workspace-1', 'periodic-task');
    localStorage.setItem('workspace-right-panel-tab-workspace-2', 'agents');
    mocks.workspaceData = { mode: 'STANDARD', periodicTaskId: 'task-1', creationSource: 'MANUAL' };
    render();
    mocks.workspaceData = { mode: 'STANDARD', periodicTaskId: null, creationSource: 'MANUAL' };
    render('workspace-2');
    expect(container.querySelector('[data-testid="agents-panel"]')).not.toBeNull();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-2')).toBe('agents');
  });

  it.each([
    ['parent', 'MANUAL', 'true'],
    ['child', 'CHILD_WORKSPACE', 'false'],
  ])('always labels the tab Agents for a %s workspace', (_kind, creationSource, isParent) => {
    mocks.workspaceData = { mode: 'STANDARD', periodicTaskId: null, creationSource };
    render();

    const agentsTab = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Agents'
    );
    expect(agentsTab).not.toBeUndefined();
    expect(container.textContent).not.toContain('Children');

    void act(() => agentsTab?.click());
    const agentsPanel = container.querySelector('[data-testid="agents-panel"]');
    expect(agentsPanel?.getAttribute('data-session')).toBe('session-1');
    expect(agentsPanel?.getAttribute('data-ready')).toBe('true');
    expect(agentsPanel?.getAttribute('data-parent')).toBe(isParent);
    expect(mocks.agentsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionName: 'Session 1' })
    );
    if (creationSource === 'MANUAL') {
      expect(container.querySelector('[data-testid="provider-subagents"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="child-workspaces"]')).not.toBeNull();
    }
  });

  it('keeps child workspaces ineligible while workspace data loads and after it resolves as child', () => {
    localStorage.setItem('workspace-right-panel-tab-workspace-1', 'agents');
    mocks.workspaceData = undefined;
    render();

    expect(container.querySelector('[data-testid="provider-subagents"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="child-workspaces"]')).toBeNull();
    expect(mocks.agentsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ isParentWorkspace: false })
    );

    mocks.workspaceData = {
      mode: 'STANDARD',
      periodicTaskId: null,
      creationSource: 'CHILD_WORKSPACE',
    };
    render();

    expect(container.querySelector('[data-testid="provider-subagents"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="child-workspaces"]')).toBeNull();
    expect(mocks.agentsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ isParentWorkspace: false })
    );
  });
});
