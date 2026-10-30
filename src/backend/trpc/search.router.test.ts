import { describe, expect, it, vi } from 'vitest';
import { searchGitHubIssues } from '@/backend/orchestration/github-issue-search.orchestrator';
import { searchRouter } from './search.trpc';

const search = vi.fn().mockResolvedValue([]);
const list = vi.fn();
const searchIssues = vi.fn();
const caller = searchRouter.createCaller({
  appContext: {
    services: {
      metadataSearchService: { search },
      projectManagementService: { list },
      githubCLIService: { searchIssues },
      searchGitHubIssues: (input: Parameters<typeof searchGitHubIssues>[0]) =>
        searchGitHubIssues(input, { listProjects: list, searchIssues }),
    },
  },
} as never);

describe('metadata search boundary', () => {
  it('provides bounded defaults and trims input', async () => {
    await expect(caller.metadata({ query: '  branch  ' })).resolves.toEqual([]);
    expect(search).toHaveBeenCalledWith({ query: 'branch', limit: 30, includeArchived: false });
  });
  it.each([{ query: 'x'.repeat(201) }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }])(
    'rejects invalid input %j',
    async (input) => {
      await expect(caller.metadata(input)).rejects.toThrow();
      expect(search).not.toHaveBeenCalled();
    }
  );
});

describe('GitHub issue search', () => {
  it('does not contact GitHub for blank queries', async () => {
    await expect(caller.githubIssues({ query: '  ' })).resolves.toEqual({
      results: [],
      errors: [],
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps successful project results when another repository fails', async () => {
    list.mockResolvedValue([
      { id: 'p1', slug: 'one', name: 'One', githubOwner: 'org', githubRepo: 'one' },
      { id: 'p2', slug: 'two', name: 'Two', githubOwner: 'org', githubRepo: 'two' },
      { id: 'p3', slug: 'local', name: 'Local', githubOwner: null, githubRepo: null },
    ]);
    searchIssues.mockImplementation((_owner, repo) => {
      if (repo === 'two') {
        throw new Error('Offline');
      }
      return [
        {
          number: 42,
          title: 'Fix search',
          body: 'Full issue',
          url: 'https://github.com/org/one/issues/42',
          state: 'OPEN',
          createdAt: '2026-01-01T00:00:00Z',
          author: { login: 'martin' },
        },
      ];
    });
    await expect(caller.githubIssues({ query: '#42' })).resolves.toEqual({
      results: [
        expect.objectContaining({
          kind: 'github_issue',
          id: 'p1:42',
          projectId: 'p1',
          title: 'Fix search',
          githubIssue: expect.objectContaining({ number: 42, body: 'Full issue' }),
        }),
      ],
      errors: ['Two: Offline'],
    });
    expect(list).toHaveBeenCalledWith({ isArchived: false });
    expect(searchIssues).toHaveBeenCalledWith('org', 'one', '#42', 30);
  });

  it('shares a bounded result budget across repositories in relevance order', async () => {
    list.mockResolvedValue([
      { id: 'new', slug: 'new', name: 'New', githubOwner: 'org', githubRepo: 'new' },
      { id: 'old', slug: 'old', name: 'Old', githubOwner: 'org', githubRepo: 'old' },
    ]);
    searchIssues.mockImplementation((_owner, repo) =>
      [1, 2, 3].map((number) => ({
        number,
        title: `Search result ${number}`,
        body: 'Matching issue',
        url: `https://github.com/org/${repo}/issues/${number}`,
        state: 'OPEN',
        createdAt: '2026-01-01T00:00:00Z',
        author: { login: 'martin' },
      }))
    );

    const result = await caller.githubIssues({ query: 'search', limit: 3 });
    expect(result.results.map((issue) => issue.id)).toEqual(['new:1', 'old:1', 'new:2']);
    expect(result.errors).toEqual([]);
  });

  it('fills remaining slots from successful repositories with more results', async () => {
    list.mockResolvedValue([
      { id: 'p1', slug: 'one', name: 'One', githubOwner: 'org', githubRepo: 'one' },
      { id: 'p2', slug: 'two', name: 'Two', githubOwner: 'org', githubRepo: 'two' },
      { id: 'p3', slug: 'three', name: 'Three', githubOwner: 'org', githubRepo: 'three' },
    ]);
    searchIssues.mockImplementation((_owner, repo) => {
      if (repo === 'two') {
        throw new Error('Offline');
      }
      return (repo === 'one' ? [] : [1, 2, 3]).map((number) => ({
        number,
        title: `Search result ${number}`,
        body: 'Matching issue',
        url: `https://github.com/org/${repo}/issues/${number}`,
        state: 'OPEN',
        createdAt: '2026-01-01T00:00:00Z',
        author: { login: 'martin' },
      }));
    });

    const result = await caller.githubIssues({ query: 'search', limit: 3 });
    expect(result.results.map((issue) => issue.id)).toEqual(['p3:1', 'p3:2', 'p3:3']);
    expect(result.errors).toEqual(['Two: Offline']);
  });
});
