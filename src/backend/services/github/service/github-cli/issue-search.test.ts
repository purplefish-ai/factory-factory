import { describe, expect, it, vi } from 'vitest';
import { searchIssues } from './issue-search';

const issue = {
  number: 42,
  title: 'Fix search',
  body: 'Details',
  html_url: 'https://github.com/org/repo/issues/42',
  state: 'open',
  created_at: '2026-01-01T00:00:00Z',
  user: { login: 'martin' },
};

describe('GitHub issue search', () => {
  it.each(['42', '#42'])('looks up %s exactly, including closed issues', async (query) => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: JSON.stringify({ ...issue, state: 'closed' }), stderr: '' });
    expect(await searchIssues(exec, 'org', 'repo', query, 10)).toEqual([
      {
        number: 42,
        title: 'Fix search',
        body: 'Details',
        url: 'https://github.com/org/repo/issues/42',
        state: 'CLOSED',
        createdAt: '2026-01-01T00:00:00Z',
        author: { login: 'martin' },
      },
    ]);
    expect(exec.mock.calls[0]?.[0]).toEqual(['api', 'repos/org/repo/issues/42']);
  });

  it('never offers a pull request as an issue to dispatch', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        ...issue,
        pull_request: { url: 'https://api.github.com/repos/org/repo/pulls/42' },
      }),
      stderr: '',
    });
    expect(await searchIssues(exec, 'org', 'repo', '#42', 10)).toEqual([]);
  });

  it('treats a missing number as no match and propagates other failures', async () => {
    const exec = vi.fn().mockRejectedValue({ stderr: 'gh: Not Found (HTTP 404)' });
    expect(await searchIssues(exec, 'org', 'repo', '42', 10)).toEqual([]);
    exec.mockRejectedValue(new Error('Offline'));
    await expect(searchIssues(exec, 'org', 'repo', '42', 10)).rejects.toThrow('Offline');
  });

  it('searches open issues without restricting assignment or fetching only the first list page', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    expect(await searchIssues(exec, 'org', 'repo', 'search polish', 20)).toEqual([]);
    expect(exec.mock.calls[0]?.[0]).toEqual([
      'issue',
      'list',
      '--repo',
      'org/repo',
      '--state',
      'open',
      '--search',
      'search polish',
      '--limit',
      '20',
      '--json',
      'number,title,body,url,state,createdAt,author',
    ]);
  });

  it('rejects malformed GitHub data', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '[{"number":"42"}]', stderr: '' });
    await expect(searchIssues(exec, 'org', 'repo', 'search', 20)).rejects.toThrow(
      'Invalid gh CLI response for searchIssues'
    );
  });
});
