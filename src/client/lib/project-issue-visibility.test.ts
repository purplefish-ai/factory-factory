import { describe, expect, it } from 'vitest';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { IssueProvider } from '@/shared/core';
import { filterIssuesForCurrentWorkspaceState } from './project-issue-visibility';

function githubIssue(issueNumber: number): NormalizedIssue {
  return {
    id: String(issueNumber),
    displayId: `#${issueNumber}`,
    title: `GitHub issue ${issueNumber}`,
    body: '',
    url: '',
    createdAt: '',
    author: '',
    provider: 'github',
    githubIssueNumber: issueNumber,
  };
}

function linearIssue(issueId: string): NormalizedIssue {
  return {
    id: issueId,
    displayId: issueId,
    title: `Linear issue ${issueId}`,
    body: '',
    url: '',
    createdAt: '',
    author: '',
    provider: 'linear',
    linearIssueId: issueId,
    linearIssueIdentifier: issueId,
  };
}

describe('filterIssuesForCurrentWorkspaceState', () => {
  it('hides GitHub issues linked in the newer workspace cache', () => {
    const issues = [githubIssue(0), githubIssue(1), githubIssue(2)];
    const workspaces = [
      { githubIssueNumber: 0, linearIssueId: null },
      { githubIssueNumber: 1, linearIssueId: null },
      { githubIssueNumber: null, linearIssueId: null },
    ];

    expect(
      filterIssuesForCurrentWorkspaceState(issues, IssueProvider.GITHUB, workspaces, new Map())
    ).toEqual([githubIssue(2)]);
  });

  it('hides Linear issues linked in the newer workspace cache', () => {
    const issues = [linearIssue('linear-1'), linearIssue('linear-2')];
    const workspaces = [{ githubIssueNumber: null, linearIssueId: 'linear-1' }];

    expect(
      filterIssuesForCurrentWorkspaceState(issues, IssueProvider.LINEAR, workspaces, new Map())
    ).toEqual([linearIssue('linear-2')]);
  });

  it('keeps a captured archive issue hidden after its workspace disappears', () => {
    const optimisticLinks = new Map([
      ['workspace-1', { githubIssueNumber: 1, linearIssueId: 'linear-1' }],
    ]);

    expect(
      filterIssuesForCurrentWorkspaceState(
        [githubIssue(1), githubIssue(2)],
        IssueProvider.GITHUB,
        [],
        optimisticLinks
      )
    ).toEqual([githubIssue(2)]);
    expect(
      filterIssuesForCurrentWorkspaceState(
        [linearIssue('linear-1'), linearIssue('linear-2')],
        IssueProvider.LINEAR,
        [],
        optimisticLinks
      )
    ).toEqual([linearIssue('linear-2')]);
  });

  it('preserves undefined issue data while the provider query is loading', () => {
    expect(
      filterIssuesForCurrentWorkspaceState(undefined, IssueProvider.GITHUB, [], new Map())
    ).toBeUndefined();
  });

  it('waits for client workspace state before exposing cached provider issues', () => {
    expect(
      filterIssuesForCurrentWorkspaceState(
        [githubIssue(1)],
        IssueProvider.GITHUB,
        undefined,
        new Map()
      )
    ).toBeUndefined();
  });
});
