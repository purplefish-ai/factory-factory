// @vitest-environment jsdom

import { act, createElement, Profiler, type ReactNode, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalOutputStream } from '@/client/lib/terminal-output-stream';
import { RightPanel } from './right-panel';
import { useWorkspacePanel, WorkspacePanelProvider } from './workspace-panel-context';

const mocks = vi.hoisted(() => ({
  agentsProps: vi.fn(),
  mobile: false,
  terminalOptions: null as null | {
    onOutput?: (terminalId: string, data: string) => void;
    onCreated?: (id: string, requestId?: string, output?: string) => void;
    onTerminalList?: (
      terminals: Array<{ id: string; createdAt: string; outputBuffer?: string }>
    ) => void;
  },
  selectTerminal: vi.fn(),
  createTerminal: vi.fn(),
  destroyTerminal: vi.fn(),
  workspaceData: undefined as undefined | { periodicTaskId: string | null; creationSource: string },
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

vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => mocks.mobile }));

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

vi.mock('@/client/features/inbox', () => ({
  useWorkspaceUnreadCounts: () => ({ data: undefined }),
  UnreadMailBadge: () => null,
  WorkspaceInboxPanel: () => createElement('section', { 'data-testid': 'inbox-panel' }),
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

vi.mock('@/client/components/terminal-instance', () => ({
  // Stands in for xterm: replays the snapshot, then writes chunks to the DOM.
  TerminalInstance: function MockTerminalInstance({ output }: { output: TerminalOutputStream }) {
    const ref = useRef<HTMLPreElement>(null);
    useEffect(() => {
      const pre = ref.current;
      if (!pre) {
        return;
      }
      pre.textContent = output.snapshot();
      return output.subscribe((event) => {
        pre.textContent =
          event.type === 'append' ? `${pre.textContent}${event.data}` : event.output;
      });
    }, [output]);
    return createElement('pre', { 'data-testid': 'terminal-output', ref });
  },
}));
vi.mock('./use-terminal-websocket', () => ({
  useTerminalWebSocket: (options: typeof mocks.terminalOptions) => {
    mocks.terminalOptions = options;
    return {
      connected: true,
      gaveUp: false,
      reconnect: vi.fn(),
      create: mocks.createTerminal,
      sendInput: vi.fn(),
      resize: vi.fn(),
      destroy: mocks.destroyTerminal,
      setActive: mocks.selectTerminal,
    };
  },
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
    mocks.mobile = false;
    mocks.terminalOptions = null;
    mocks.workspaceData = {
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

  it('keeps restored terminal tabs while viewing Logs and reopens the selected terminal', async () => {
    render();
    await act(async () => {
      mocks.terminalOptions?.onTerminalList?.([
        { id: 'first', createdAt: '', outputBuffer: 'first output' },
        { id: 'second', createdAt: '', outputBuffer: 'second output' },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
    expect(button('Terminal 2')).toBeDefined();
    await act(async () => button('Terminal 2').click());
    await vi.dynamicImportSettled();
    expect(container.querySelector('[data-testid="terminal-output"]')?.textContent).toBe(
      'second output'
    );
    act(() => button('Logs').click());
    expect(button('Terminal 2')).toBeDefined();
    expect(container.querySelector('[data-testid="terminal-output"]')).toBeNull();
    await act(async () => button('Terminal 2').click());
    expect(container.querySelector('[data-testid="terminal-output"]')?.textContent).toBe(
      'second output'
    );
    expect(mocks.selectTerminal).toHaveBeenLastCalledWith('second');
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it('writes terminal chunks without re-rendering the right panel, even while hidden', async () => {
    const commits = vi.fn();
    void act(() =>
      root.render(
        <WorkspacePanelProvider workspaceId="workspace-1">
          <Profiler id="right-panel" onRender={commits}>
            <RightPanel workspaceId="workspace-1" />
          </Profiler>
        </WorkspacePanelProvider>
      )
    );
    await act(async () => {
      mocks.terminalOptions?.onTerminalList?.([
        { id: 'dev-server', createdAt: '', outputBuffer: 'ready\r\n' },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
    await act(async () => button('Terminal 1').click());
    await vi.dynamicImportSettled();
    const terminalOutput = () =>
      container.querySelector('[data-testid="terminal-output"]')?.textContent;
    expect(terminalOutput()).toBe('ready\r\n');
    commits.mockClear();

    act(() => {
      mocks.terminalOptions?.onOutput?.('dev-server', 'GET / 200\r\n');
      mocks.terminalOptions?.onOutput?.('dev-server', 'GET /app.js 200\r\n');
    });
    expect(terminalOutput()).toBe('ready\r\nGET / 200\r\nGET /app.js 200\r\n');
    expect(commits).not.toHaveBeenCalled();

    // A dev server keeps writing while the user reads logs.
    act(() => button('Logs').click());
    commits.mockClear();
    act(() => mocks.terminalOptions?.onOutput?.('dev-server', 'GET /hidden 200\r\n'));
    expect(commits).not.toHaveBeenCalled();

    await act(async () => button('Terminal 1').click());
    expect(terminalOutput()).toBe('ready\r\nGET / 200\r\nGET /app.js 200\r\nGET /hidden 200\r\n');
  });

  it('creates Terminal 1 when the empty Terminal tab is clicked', async () => {
    render();
    act(() =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Logs')?.click()
    );
    act(() => mocks.terminalOptions?.onTerminalList?.([]));
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    const terminal = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Terminal'
    )!;
    await act(async () => terminal.click());
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Terminal 1');
    expect(container.textContent).not.toContain('No terminal open');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Close Terminal 1"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.createTerminal).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Terminal 1');
    await act(async () =>
      mocks.terminalOptions?.onCreated?.(
        'new-terminal',
        mocks.createTerminal.mock.calls[1]?.[0],
        'ready $'
      )
    );
    await vi.dynamicImportSettled();
    expect(container.querySelector('[data-testid="terminal-output"]')?.textContent).toBe('ready $');
  });

  it('opens Inbox from the toolbar and remembers the selection', () => {
    render();
    const inbox = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Inbox'
    );
    expect(inbox).toBeDefined();
    act(() => inbox?.click());
    expect(container.querySelector('[data-testid="inbox-panel"]')).not.toBeNull();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('inbox');
  });

  it('shows only the selected tool on mobile and remembers it across closing the panel', () => {
    mocks.mobile = true;
    render();
    const changes = container.querySelector('[data-testid="changes-panel"]');
    expect(changes?.closest('[hidden]')).toBeNull();
    const terminalTab = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Terminal'
    );
    void act(() =>
      terminalTab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    );
    expect(changes?.closest('[hidden]')).not.toBeNull();
    expect(terminalTab?.getAttribute('aria-selected')).toBe('true');
    // The provider outlives the drawer content.
    void act(() =>
      root.render(
        <WorkspacePanelProvider workspaceId="workspace-1">
          <span>Closed</span>
        </WorkspacePanelProvider>
      )
    );
    render();
    expect(
      container.querySelector('[data-testid="changes-panel"]')?.closest('[hidden]')
    ).not.toBeNull();
    expect(
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Terminal')
        ?.getAttribute('aria-selected')
    ).toBe('true');
  });

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

  it('opens Changes for a former auto-iteration workspace after its data loads', () => {
    localStorage.setItem('workspace-right-panel-tab-workspace-1', 'auto-iteration');
    mocks.workspaceData = undefined;
    render();
    const legacyWorkspace = {
      mode: 'AUTO_ITERATION',
      periodicTaskId: null,
      creationSource: 'MANUAL',
    };
    mocks.workspaceData = legacyWorkspace;
    render();
    expect(container.querySelector('[data-testid="changes-panel"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Iterations');
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('changes');
  });

  it('waits for workspace capabilities before rejecting a periodic-task preference', () => {
    localStorage.setItem('workspace-right-panel-tab-workspace-1', 'periodic-task');
    mocks.workspaceData = undefined;
    render();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('periodic-task');
    mocks.workspaceData = { periodicTaskId: 'task-1', creationSource: 'MANUAL' };
    render();
    expect(container.querySelector('[data-testid="periodic-task-panel"]')).not.toBeNull();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('periodic-task');
    // "Agent" alone read as the chat's coding agent; name the Agents-section concept.
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toContain(
      'Scheduled automation'
    );
  });

  it('falls back when an open workspace loses its periodic task', () => {
    localStorage.setItem('workspace-right-panel-tab-workspace-1', 'periodic-task');
    mocks.workspaceData = { periodicTaskId: 'task-1', creationSource: 'MANUAL' };
    render();
    expect(container.querySelector('[data-testid="periodic-task-panel"]')).not.toBeNull();
    mocks.workspaceData = { periodicTaskId: null, creationSource: 'MANUAL' };
    render();
    expect(container.querySelector('[data-testid="changes-panel"]')).not.toBeNull();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-1')).toBe('changes');
  });

  it('preserves another workspace preference when switching from a periodic task', () => {
    localStorage.setItem('workspace-right-panel-tab-workspace-1', 'periodic-task');
    localStorage.setItem('workspace-right-panel-tab-workspace-2', 'agents');
    mocks.workspaceData = { periodicTaskId: 'task-1', creationSource: 'MANUAL' };
    render();
    mocks.workspaceData = { periodicTaskId: null, creationSource: 'MANUAL' };
    render('workspace-2');
    expect(container.querySelector('[data-testid="agents-panel"]')).not.toBeNull();
    expect(localStorage.getItem('workspace-right-panel-tab-workspace-2')).toBe('agents');
  });

  it.each([
    ['parent', 'MANUAL', 'true'],
    ['child', 'CHILD_WORKSPACE', 'false'],
  ])('always labels the tab Sub-agents for a %s workspace', (_kind, creationSource, isParent) => {
    mocks.workspaceData = { periodicTaskId: null, creationSource };
    render();

    const agentsTab = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Subagents'
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
