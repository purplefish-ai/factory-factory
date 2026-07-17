// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveWorkspaceDialogProps } from '@/components/workspace/archive-workspace-dialog';
import { WorkspaceDetailView, type WorkspaceDetailViewProps } from './workspace-detail-view';

const archiveDialogMock = vi.hoisted(() =>
  vi.fn((props: ArchiveWorkspaceDialogProps) =>
    createElement('div', {
      'data-testid': 'archive-dialog',
      'data-active-child-count': props.activeChildCount,
    })
  )
);

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
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

vi.mock('@/components/workspace', () => ({
  ArchiveWorkspaceDialog: archiveDialogMock,
  RightPanel: () => createElement('aside', null, 'Right panel'),
  WorkspaceContentView: ({ children }: { children: ReactNode }) =>
    createElement('main', null, children),
}));

vi.mock('./auto-iteration-progress-banner', () => ({
  AutoIterationProgressBanner: () => null,
}));

vi.mock('./workspace-detail-chat-content', () => ({
  ChatContent: () => createElement('section', null, 'Chat'),
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
      sessions: [],
      selectedDbSessionId: null,
      sessionSummariesById: new Map(),
      isDeletingSession: false,
      handleSelectSession: vi.fn(),
      handleNewChat: vi.fn(),
      handleCloseChatSession: vi.fn(),
      handleQuickAction: vi.fn(),
      handleRestartSession: vi.fn(),
      maxSessions: 5,
      hasWorktreePath: true,
      selectedProvider: 'CLAUDE',
      setSelectedProvider: vi.fn(),
    },
    chat: {} as WorkspaceDetailViewProps['chat'],
    rightPanelVisible: false,
    setRightPanelVisible: vi.fn(),
    archiveDialog: {
      open: true,
      setOpen: vi.fn(),
      hasUncommitted: false,
      activeChildCount,
      onConfirm: vi.fn(),
    },
  };
}

function renderView(props: WorkspaceDetailViewProps): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
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
    props.workspaceState.setupWarningDismissed = null;

    const { container, root } = renderView(props);

    expect(container.textContent).not.toContain('Script failed');

    root.unmount();
  });
});
