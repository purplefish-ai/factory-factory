// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueProvider } from '@/shared/core';

const mocks = vi.hoisted(() => ({
  githubUseQuery: vi.fn(),
  linearUseQuery: vi.fn(),
  shouldSyncHealth: vi.fn(),
  syncHealth: vi.fn(),
  checkCLIHealth: {
    setData: vi.fn(),
    fetch: vi.fn(),
    invalidate: vi.fn(),
  },
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ admin: { checkCLIHealth: mocks.checkCLIHealth } }),
    github: {
      listIssuesForProject: { useQuery: mocks.githubUseQuery },
    },
    linear: {
      listIssuesForProject: { useQuery: mocks.linearUseQuery },
    },
  },
}));

vi.mock('@/client/lib/cli-health-cache', () => ({
  shouldSyncGitHubCLIHealthFromIssuesResponse: mocks.shouldSyncHealth,
  syncGitHubCLIHealth: mocks.syncHealth,
}));

import { useProjectIssues } from './use-project-issues';

type HookResult = ReturnType<typeof useProjectIssues>;

interface HarnessProps {
  projectId: string | undefined;
  issueProvider: IssueProvider;
  resultRef: { current: HookResult | null };
}

function Harness({ projectId, issueProvider, resultRef }: HarnessProps) {
  resultRef.current = useProjectIssues(projectId, issueProvider);
  return null;
}

const githubHealth = { isInstalled: true, isAuthenticated: true };
const githubRefetch = vi.fn();
const linearRefetch = vi.fn();

function githubQueryResult() {
  return {
    data: {
      issues: [
        {
          number: 42,
          title: 'GitHub issue',
          body: 'GitHub body',
          url: 'https://github.com/purplefish-ai/factory-factory/issues/42',
          state: 'OPEN',
          createdAt: '2026-07-17T10:00:00.000Z',
          author: { login: 'octocat' },
        },
      ],
      health: githubHealth,
      error: null,
    },
    isLoading: true,
    refetch: githubRefetch,
  };
}

function linearQueryResult() {
  return {
    data: {
      issues: [
        {
          id: 'linear-42',
          identifier: 'FF-42',
          title: 'Linear issue',
          description: 'Linear body',
          url: 'https://linear.app/factory/issue/FF-42',
          state: 'Todo',
          createdAt: '2026-07-17T11:00:00.000Z',
          assigneeName: null,
        },
      ],
      error: null,
    },
    isLoading: false,
    refetch: linearRefetch,
  };
}

describe('useProjectIssues', () => {
  let container: HTMLDivElement;
  let root: Root;
  const resultRef: { current: HookResult | null } = { current: null };

  function render(projectId: string | undefined, issueProvider: IssueProvider) {
    flushSync(() => {
      root.render(createElement(Harness, { projectId, issueProvider, resultRef }));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.githubUseQuery.mockReturnValue(githubQueryResult());
    mocks.linearUseQuery.mockReturnValue(linearQueryResult());
    mocks.shouldSyncHealth.mockReturnValue(true);
    resultRef.current = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('loads and normalizes GitHub issues with the shared query policy', () => {
    render('project-1', IssueProvider.GITHUB);

    expect(mocks.githubUseQuery).toHaveBeenCalledWith(
      { projectId: 'project-1' },
      { enabled: true, refetchInterval: 60_000, staleTime: 30_000 }
    );
    expect(mocks.linearUseQuery).toHaveBeenCalledWith(
      { projectId: 'project-1' },
      { enabled: false, refetchInterval: 60_000, staleTime: 30_000 }
    );
    expect(resultRef.current).toMatchObject({
      isLoading: true,
      refetch: githubRefetch,
      issues: [
        {
          id: '42',
          displayId: '#42',
          title: 'GitHub issue',
          provider: 'github',
          githubIssueNumber: 42,
        },
      ],
    });
    expect(mocks.shouldSyncHealth).toHaveBeenCalledWith(githubHealth, null);
    expect(mocks.syncHealth).toHaveBeenCalledWith(mocks.checkCLIHealth, githubHealth);
  });

  it('selects and normalizes only Linear issue state', () => {
    mocks.githubUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      refetch: githubRefetch,
    });

    render('project-1', IssueProvider.LINEAR);

    expect(mocks.githubUseQuery).toHaveBeenCalledWith(
      { projectId: 'project-1' },
      { enabled: false, refetchInterval: 60_000, staleTime: 30_000 }
    );
    expect(mocks.linearUseQuery).toHaveBeenCalledWith(
      { projectId: 'project-1' },
      { enabled: true, refetchInterval: 60_000, staleTime: 30_000 }
    );
    expect(resultRef.current).toMatchObject({
      isLoading: false,
      refetch: linearRefetch,
      issues: [
        {
          id: 'linear-42',
          displayId: 'FF-42',
          title: 'Linear issue',
          author: 'Unassigned',
          provider: 'linear',
          linearIssueId: 'linear-42',
          linearIssueIdentifier: 'FF-42',
        },
      ],
    });
    expect(mocks.syncHealth).not.toHaveBeenCalled();
  });

  it('disables both provider queries without a project', () => {
    render(undefined, IssueProvider.GITHUB);

    expect(mocks.githubUseQuery).toHaveBeenCalledWith(
      { projectId: '' },
      { enabled: false, refetchInterval: 60_000, staleTime: 30_000 }
    );
    expect(mocks.linearUseQuery).toHaveBeenCalledWith(
      { projectId: '' },
      { enabled: false, refetchInterval: 60_000, staleTime: 30_000 }
    );
  });

  it('does not overwrite GitHub health when the response is not eligible', () => {
    mocks.shouldSyncHealth.mockReturnValue(false);

    render('project-1', IssueProvider.GITHUB);

    expect(mocks.shouldSyncHealth).toHaveBeenCalledWith(githubHealth, null);
    expect(mocks.syncHealth).not.toHaveBeenCalled();
  });
});
