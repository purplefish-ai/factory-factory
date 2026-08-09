// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanel } from './right-panel';

const mocks = vi.hoisted(() => ({
  agentsProps: vi.fn(),
  workspaceData: undefined as
    | undefined
    | { mode: string; periodicTaskId: null; creationSource: string },
}));

vi.mock('@phosphor-icons/react', () => ({
  ArrowsClockwiseIcon: () => null,
  CalendarIcon: () => null,
  CameraIcon: () => null,
  FileDashedIcon: () => null,
  FilesIcon: () => null,
  ListChecksIcon: () => null,
  PlusIcon: () => null,
  TerminalIcon: () => null,
  TreeStructureIcon: () => null,
  XIcon: () => null,
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      get: {
        useQuery: () => ({
          data: mocks.workspaceData,
        }),
      },
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

vi.mock('./workspace-panel-context', () => ({
  useWorkspacePanel: () => ({ activeBottomTab: 'terminal', setActiveBottomTab: vi.fn() }),
}));

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

vi.mock('./auto-iteration-panel', () => ({ AutoIterationPanel: () => null }));
vi.mock('./combined-changes-panel', () => ({ CombinedChangesPanel: () => null }));
vi.mock('./dev-logs-panel', () => ({ DevLogsPanel: () => null }));
vi.mock('./file-browser-panel', () => ({ FileBrowserPanel: () => null }));
vi.mock('./periodic-task-panel', () => ({ PeriodicTaskPanel: () => null }));
vi.mock('./screenshots-panel', () => ({ ScreenshotsPanel: () => null }));
vi.mock('./setup-logs-panel', () => ({ SetupLogsPanel: () => null }));
vi.mock('./todo-panel-container', () => ({ TodoPanelContainer: () => null }));

vi.mock('./terminal-panel', () => ({
  TerminalPanel: () => null,
}));

vi.mock('./terminal-tab-bar', () => ({
  TerminalTabBar: () => null,
}));

describe('RightPanel Agents tab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
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
  });

  function render() {
    void act(() =>
      root.render(
        createElement(RightPanel, {
          workspaceId: 'workspace-1',
          selectedSessionId: 'session-1',
          selectedSessionReady: true,
          onOpenSubagent: vi.fn(),
        })
      )
    );
  }

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
