// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueCard } from './issue-card';

const mocks = vi.hoisted(() => ({
  listWithKanbanStateInvalidateMock: vi.fn(),
  getProjectSummaryStateInvalidateMock: vi.fn(),
  getSetDataMock: vi.fn(),
  createWorkspaceMutateMock: vi.fn(),
  createWorkspaceMutationOptions: undefined as Record<string, unknown> | undefined,
  createOptimisticWorkspaceCacheDataMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock('lucide-react', () => ({
  CircleDot: () => null,
  Play: () => null,
  User: () => null,
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
          data: { ratchetEnabled: false },
          isLoading: false,
        }),
      },
    },
    workspace: {
      create: {
        useMutation: (options: Record<string, unknown>) => {
          mocks.createWorkspaceMutationOptions = options;
          return {
            mutate: mocks.createWorkspaceMutateMock,
            isPending: false,
          };
        },
      },
    },
  },
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: import('react').ButtonHTMLAttributes<HTMLButtonElement>) =>
    createElement('button', props, children),
}));

vi.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  CardContent: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  CardHeader: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
  CardTitle: ({ children, ...props }: import('react').HTMLAttributes<HTMLDivElement>) =>
    createElement('div', props, children),
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SelectContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SelectItem: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SelectTrigger: ({ children }: { children: ReactNode }) => createElement('button', null, children),
  SelectValue: () => null,
}));

vi.mock('@/components/workspace', () => ({
  RatchetToggleButton: () => null,
}));

function renderCard(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(
      createElement(IssueCard, {
        projectId: 'project-1',
        issue: {
          id: 'github-42',
          provider: 'github',
          title: 'Fix login redirect',
          body: 'Issue body',
          url: 'https://github.com/acme/repo/issues/42',
          displayId: '#42',
          author: 'octocat',
          createdAt: '2026-03-14T12:00:00.000Z',
          githubIssueNumber: 42,
        },
      })
    );
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

describe('IssueCard', () => {
  it('invalidates sidebar project summary after creating a workspace from an issue', () => {
    const { container, root } = renderCard();

    const mutationOptions = mocks.createWorkspaceMutationOptions as {
      onSuccess: (workspace: { id: string }) => void;
    };

    mocks.createOptimisticWorkspaceCacheDataMock.mockReturnValue({ id: 'ws-1' });

    mutationOptions.onSuccess({ id: 'ws-1' });

    expect(mocks.listWithKanbanStateInvalidateMock).toHaveBeenCalledWith({
      projectId: 'project-1',
    });
    expect(mocks.getProjectSummaryStateInvalidateMock).toHaveBeenCalledWith({
      projectId: 'project-1',
    });

    root.unmount();
    container.remove();
  });

  it('shows a toast when creating a workspace from an issue fails', () => {
    const { container, root } = renderCard();

    const mutationOptions = mocks.createWorkspaceMutationOptions as {
      onError: (error: Error) => void;
    };

    mutationOptions.onError(new Error('Workspace creation failed'));

    expect(mocks.toastErrorMock).toHaveBeenCalledWith('Workspace creation failed');

    root.unmount();
    container.remove();
  });
});
