// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueLaunchSheet } from './issue-launch-sheet';

const mocks = vi.hoisted(() => ({
  userSettings: {
    defaultSessionProvider: 'CLAUDE' as 'CLAUDE' | 'CODEX',
    ratchetEnabled: false,
  },
  listWithKanbanStateInvalidateMock: vi.fn(),
  getProjectSummaryStateInvalidateMock: vi.fn(),
  getSetDataMock: vi.fn(),
  createWorkspaceMutateMock: vi.fn(),
  createOptimisticWorkspaceCacheDataMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('lucide-react', () => ({
  ExternalLink: () => null,
  Play: () => null,
}));

vi.mock('@/client/lib/workspace-cache-helpers', () => ({
  createOptimisticWorkspaceCacheData: mocks.createOptimisticWorkspaceCacheDataMock,
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastErrorMock,
  },
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        get: { setData: mocks.getSetDataMock },
        listWithKanbanState: {
          invalidate: mocks.listWithKanbanStateInvalidateMock,
        },
        getProjectSummaryState: {
          invalidate: mocks.getProjectSummaryStateInvalidateMock,
        },
      },
    }),
    userSettings: {
      get: {
        useQuery: () => ({
          data: mocks.userSettings,
          isLoading: false,
        }),
      },
    },
    workspace: {
      create: {
        useMutation: () => ({
          mutate: mocks.createWorkspaceMutateMock,
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    asChild: _asChild,
    ...props
  }: import('react').ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) =>
    createElement('button', props, children),
}));

vi.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: import('react').LabelHTMLAttributes<HTMLLabelElement>) =>
    createElement('label', props, children),
}));

vi.mock('@/components/ui/select', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const SelectContext = React.createContext<{
    onValueChange?: (value: string) => void;
  }>({});

  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: ReactNode;
      onValueChange?: (value: string) => void;
    }) =>
      createElement(
        SelectContext.Provider,
        { value: { onValueChange } },
        createElement('div', null, children)
      ),
    SelectContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
    SelectItem: ({ children, value }: { children: ReactNode; value: string }) => {
      const context = React.useContext(SelectContext);
      return createElement(
        'button',
        {
          type: 'button',
          onClick: () => context.onValueChange?.(value),
        },
        children
      );
    },
    SelectTrigger: ({ children, ...props }: import('react').HTMLAttributes<HTMLButtonElement>) =>
      createElement('button', props, children),
    SelectValue: () => null,
  };
});

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? createElement('div', null, children) : null,
  SheetContent: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  SheetDescription: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  SheetFooter: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  SheetHeader: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  SheetTitle: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
}));

vi.mock('@/components/workspace', () => ({
  RatchetToggleButton: () => null,
}));

const issue = {
  id: 'github-42',
  provider: 'github' as const,
  title: 'Fix login redirect',
  body: 'Issue body',
  url: 'https://github.com/acme/repo/issues/42',
  displayId: '#42',
  author: 'octocat',
  createdAt: '2026-03-14T12:00:00.000Z',
  githubIssueNumber: 42,
};

function renderSheet(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(
      createElement(IssueLaunchSheet, {
        projectId: 'project-1',
        issue,
        open: true,
        onOpenChange: vi.fn(),
      })
    );
  });

  return { container, root };
}

function clickButton(container: HTMLDivElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  );

  if (!button) {
    throw new Error(`${label} button not found`);
  }

  flushSync(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  mocks.userSettings = {
    defaultSessionProvider: 'CLAUDE',
    ratchetEnabled: false,
  };
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('IssueLaunchSheet', () => {
  it('does not reset a user-selected provider after settings refetch', () => {
    const { container, root } = renderSheet();

    clickButton(container, 'Codex');

    mocks.userSettings = {
      defaultSessionProvider: 'CLAUDE',
      ratchetEnabled: true,
    };

    flushSync(() => {
      root.render(
        createElement(IssueLaunchSheet, {
          projectId: 'project-1',
          issue,
          open: true,
          onOpenChange: vi.fn(),
        })
      );
    });

    clickButton(container, 'Start');

    expect(mocks.createWorkspaceMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'CODEX',
      })
    );

    root.unmount();
    container.remove();
  });
});
