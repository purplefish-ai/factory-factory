// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSelection } from '@/client/features/subagents';
import type { ArchiveWorkspaceDialogProps } from '@/client/features/workspace/archive-workspace-dialog';
import type { ChatContentProps } from './workspace-detail-chat-content';
import { WorkspaceDetailView, type WorkspaceDetailViewProps } from './workspace-detail-view';

const archiveDialogMock = vi.hoisted(() =>
  vi.fn((props: ArchiveWorkspaceDialogProps) =>
    createElement('div', {
      'data-testid': 'archive-dialog',
      'data-active-child-count': props.activeChildCount,
    })
  )
);

const rightPanelMock = vi.hoisted(() =>
  vi.fn(
    (props: {
      isTakingScreenshots: boolean;
      onTakeScreenshots: () => Promise<void>;
      selectedSessionId: string | null;
      selectedSessionName: string | null;
      selectedSessionReady: boolean;
      onOpenSubagent?: (selection: SubagentSelection) => void;
    }) =>
      createElement('div', null, [
        createElement(
          'button',
          {
            key: 'screenshots',
            'data-testid': 'take-screenshots',
            'data-loading': String(Boolean(props.isTakingScreenshots)),
            onClick: () => {
              void props.onTakeScreenshots();
            },
            type: 'button',
          },
          'Take screenshots'
        ),
        createElement(
          'button',
          {
            key: 'subagent',
            'data-testid': 'open-subagent',
            onClick: () =>
              props.onOpenSubagent?.({
                parentSessionId: 'session-1',
                parentSessionName: props.selectedSessionName ?? 'Wrong fallback',
                subagent: {
                  id: 'child-1',
                  name: 'Security review',
                  status: 'running',
                  createdAt: '2026-08-08T11:50:00.000Z',
                  updatedAt: '2026-08-08T11:59:00.000Z',
                  completedAt: null,
                  latestActivity: 'Checking authentication boundaries',
                  resultPreview: null,
                },
              }),
            type: 'button',
          },
          'Open sub-agent'
        ),
        createElement(
          'button',
          {
            key: 'subagent-2',
            'data-testid': 'open-subagent-2',
            onClick: () =>
              props.onOpenSubagent?.({
                parentSessionId: 'session-1',
                parentSessionName: props.selectedSessionName ?? 'Wrong fallback',
                subagent: {
                  id: 'child-2',
                  name: 'Test review',
                  status: 'running',
                  createdAt: '2026-08-08T11:51:00.000Z',
                  updatedAt: '2026-08-08T11:59:00.000Z',
                  completedAt: null,
                  latestActivity: 'Checking test coverage',
                  resultPreview: null,
                },
              }),
            type: 'button',
          },
          'Open second sub-agent'
        ),
      ])
  )
);

const workspaceContentViewMock = vi.hoisted(() => vi.fn());
const useIsMobileMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: useIsMobileMock,
}));

vi.mock('@/client/components/loading', () => ({
  Loading: ({ message }: { message: string }) => createElement('div', null, message),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: import('react').ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));

vi.mock('@/components/ui/resizable', () => ({
  ResizableHandle: () => createElement('div', null),
  ResizablePanel: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  ResizablePanelGroup: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
}));

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetDescription: ({ children }: { children: ReactNode }) => createElement('p', null, children),
  SheetHeader: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SheetTitle: ({ children }: { children: ReactNode }) => createElement('h2', null, children),
}));

vi.mock('@/client/features/workspace', () => ({
  ArchiveWorkspaceDialog: archiveDialogMock,
  RightPanel: rightPanelMock,
  WorkspaceContentView: (props: { children: ReactNode; selectedSessionId: string | null }) => {
    workspaceContentViewMock(props);
    return createElement('main', null, props.children);
  },
}));

vi.mock('./auto-iteration-progress-banner', () => ({
  AutoIterationProgressBanner: () => null,
}));

vi.mock('./workspace-detail-chat-content', () => ({
  ChatContent: (props: ChatContentProps) =>
    createElement('section', { ref: props.viewportRef, 'data-testid': 'parent-chat' }, 'Chat'),
}));

vi.mock('./workspace-overlays', () => ({
  ArchivingOverlay: () => createElement('div', null, 'Archiving'),
  ScriptFailedBanner: () => createElement('div', null, 'Script failed'),
}));

function createMutationLike() {
  return {
    mutate: vi.fn(),
    isPending: false,
  };
}

function createInitStatus(
  showDismiss: boolean
): NonNullable<WorkspaceDetailViewProps['workspaceState']['workspaceInitStatus']> {
  return {
    status: 'READY',
    initErrorMessage: 'Setup failed',
    initOutput: null,
    initStartedAt: null,
    initCompletedAt: null,
    phase: 'READY_WITH_WARNING',
    chatBanner: {
      kind: 'warning',
      message: 'Setup failed',
      showRetry: true,
      showPlay: false,
      showDismiss,
    },
    hasStartupScript: true,
    hasWorktreePath: true,
  };
}

function createViewProps(activeChildCount: number): WorkspaceDetailViewProps {
  return {
    workspaceState: {
      workspaceLoading: false,
      workspace: {
        id: 'workspace-1',
        mode: 'STANDARD',
      } as WorkspaceDetailViewProps['workspaceState']['workspace'],
      workspaceId: 'workspace-1',
      handleBackToWorkspaces: vi.fn(),
      isScriptFailed: false,
      workspaceInitStatus: undefined,
      setupWarningDismissed: false,
      dismissSetupWarning: vi.fn(),
    },
    header: {
      archivePending: false,
      availableIdes: [],
      preferredIde: '',
      openInIde: createMutationLike(),
      handleArchiveRequest: vi.fn(),
      handleQuickAction: vi.fn(),
      running: false,
      isCreatingSession: false,
      hasChanges: false,
    },
    sessionTabs: {
      sessions: [
        {
          id: 'session-1',
          name: null,
          status: 'IDLE',
          workflow: 'feature',
          createdAt: new Date('2026-08-08T11:00:00.000Z'),
        },
        {
          id: 'session-2',
          name: 'Named session',
          status: 'IDLE',
          workflow: 'feature',
          createdAt: new Date('2026-08-08T11:05:00.000Z'),
        },
      ] as WorkspaceDetailViewProps['sessionTabs']['sessions'],
      selectedDbSessionId: 'session-1',
      selectedSessionReady: true,
      sessionSummariesById: new Map(),
      isDeletingSession: false,
      handleSelectSession: vi.fn(),
      handleNewChat: vi.fn(),
      handleCloseChatSession: vi.fn(),
      handleQuickAction: vi.fn(),
      handleRestartSession: vi.fn(),
      handleOpenSubagentTab: vi.fn(),
      maxSessions: 5,
      hasWorktreePath: true,
      selectedProvider: 'CLAUDE',
      setSelectedProvider: vi.fn(),
    },
    chat: {
      viewportRef: { current: null },
      onScroll: vi.fn(),
    } as unknown as WorkspaceDetailViewProps['chat'],
    rightPanelVisible: false,
    setRightPanelVisible: vi.fn(),
    archiveDialog: {
      open: true,
      setOpen: vi.fn(),
      activeChildCount,
      onConfirm: vi.fn(),
    },
  };
}

function renderView(props: WorkspaceDetailViewProps): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  void act(() => {
    root.render(createElement(WorkspaceDetailView, props));
  });

  return { container, root };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  useIsMobileMock.mockReturnValue(false);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('WorkspaceDetailView', () => {
  it('passes active child count to the archive dialog', () => {
    const { container, root } = renderView(createViewProps(2));

    expect(archiveDialogMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ activeChildCount: 2 })
    );
    expect(
      container
        .querySelector('[data-testid="archive-dialog"]')
        ?.getAttribute('data-active-child-count')
    ).toBe('2');

    root.unmount();
  });

  it('does not render the script warning before dismissal state hydrates', () => {
    const props = createViewProps(0);
    props.workspaceState.isScriptFailed = true;
    props.workspaceState.workspaceInitStatus = createInitStatus(true);
    props.workspaceState.setupWarningDismissed = null;

    const { container, root } = renderView(props);

    expect(container.textContent).not.toContain('Script failed');

    root.unmount();
  });

  it('keeps non-dismissible script warnings visible during dismissal hydration', () => {
    const props = createViewProps(0);
    props.workspaceState.isScriptFailed = true;
    props.workspaceState.workspaceInitStatus = createInitStatus(false);
    props.workspaceState.setupWarningDismissed = null;

    const { container, root } = renderView(props);

    expect(container.textContent).toContain('Script failed');

    root.unmount();
  });

  it('clears screenshot loading when session creation fails', async () => {
    let rejectSessionCreation: ((error: Error) => void) | undefined;
    const props = createViewProps(0);
    props.rightPanelVisible = true;
    props.header.handleQuickAction = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSessionCreation = reject;
        })
    );

    const { container, root } = renderView(props);
    const takeScreenshotsButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="take-screenshots"]'
    );

    expect(takeScreenshotsButton?.dataset.loading).toBe('false');

    await act(() => {
      takeScreenshotsButton?.click();
    });
    expect(takeScreenshotsButton?.dataset.loading).toBe('true');

    await act(() => {
      rejectSessionCreation?.(new Error('Session creation failed'));
    });

    expect(takeScreenshotsButton?.dataset.loading).toBe('false');

    root.unmount();
  });

  it('opens a sub-agent tab without replacing or selecting the parent chat', () => {
    const props = createViewProps(0);
    props.rightPanelVisible = true;
    const { container, root } = renderView(props);
    const parentChat = container.querySelector('[data-testid="parent-chat"]');

    void act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-subagent"]')?.click();
    });

    expect(props.sessionTabs.handleOpenSubagentTab).toHaveBeenCalledOnce();
    expect(props.sessionTabs.handleOpenSubagentTab).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'session-1',
        parentSessionName: 'Session 1',
        subagent: expect.objectContaining({ id: 'child-1', name: 'Security review' }),
      })
    );
    expect(container.querySelector('[data-testid="parent-chat"]')).toBe(parentChat);
    expect(props.sessionTabs.handleSelectSession).not.toHaveBeenCalled();
    root.unmount();
  });

  it('closes the mobile right-panel sheet after opening a sub-agent', () => {
    useIsMobileMock.mockReturnValue(true);
    const props = createViewProps(0);
    props.rightPanelVisible = true;
    const { container, root } = renderView(props);

    void act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="open-subagent"]')?.click();
    });

    expect(props.sessionTabs.handleOpenSubagentTab).toHaveBeenCalledOnce();
    expect(props.setRightPanelVisible).toHaveBeenCalledWith(false);

    void act(() => root.unmount());
  });

  it('ignores a sub-agent selection owned by another parent session', () => {
    const props = createViewProps(0);
    props.rightPanelVisible = true;
    const { root } = renderView(props);
    const onOpenSubagent = rightPanelMock.mock.calls.at(-1)?.[0].onOpenSubagent;

    void act(() => {
      onOpenSubagent?.({
        parentSessionId: 'session-2',
        parentSessionName: 'Named session',
        subagent: {
          id: 'foreign-child',
          name: 'Foreign review',
          status: 'running',
          createdAt: null,
          updatedAt: null,
          completedAt: null,
          latestActivity: null,
          resultPreview: null,
        },
      });
    });
    expect(props.sessionTabs.handleOpenSubagentTab).not.toHaveBeenCalled();
    root.unmount();
  });
});
