import { execFile } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
import { githubCLIService } from './github-cli.service';

const event = {
  id: '90071992547409931234',
  event: 'labeled',
  created_at: '2026-11-01T12:00:00Z',
  actor: { id: 'actor' },
  label: { name: 'agent' },
  issue: {
    number: 7,
    title: 'Investigate',
    body: 'Details',
    html_url: 'https://github.com/org/repo/issues/7',
    user: { id: 'creator' },
  },
};
function response(rows: unknown[], link = '') {
  return {
    stdout: `HTTP/2.0 200 OK\r\n${link ? `Link: ${link}\r\n` : ''}\r\n${JSON.stringify(rows)}`,
    stderr: '',
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  githubCLIService.clearCaches();
});

it('preserves opaque feed order, drops PR content, and follows repository-ID pagination', async () => {
  vi.mocked(execFile).mockResolvedValue(
    response(
      [
        { ...event, id: 'pr', issue: { pull_request: {}, body: 'private PR content' } },
        { id: 'unsupported', event: 'unlabeled' },
        event,
      ],
      '<https://api.github.com/repositories/123/issues/events?per_page=100&page=2>; rel="next"'
    ) as never
  );
  const signal = new AbortController().signal;
  const page = await githubCLIService.listAgentIssueEvents(
    { repository: 'org/repo', repositoryId: '123', page: 1, perPage: 100 },
    signal
  );
  expect(page.nextPage).toBe(2);
  expect(page.events.map((item) => item.providerEventId)).toEqual([
    'pr',
    'unsupported',
    '90071992547409931234',
  ]);
  expect(page.events[0]).toEqual({ providerEventId: 'pr', payload: null });
  expect(page.events[1]).toEqual({ providerEventId: 'unsupported', payload: null });
  expect(page.events[2]?.payload).toMatchObject({
    provider: 'GITHUB',
    repositoryId: '123',
    action: 'labeled',
    issue: { addedLabel: 'agent' },
  });
  expect(execFile).toHaveBeenCalledWith(
    'gh',
    expect.arrayContaining(['--include']),
    expect.objectContaining({ signal, maxBuffer: 10 * 1024 * 1024 })
  );
});

it('does not round numeric provider identities during JSON parsing', async () => {
  const result = response([event]);
  result.stdout = result.stdout.replace('"90071992547409931234"', '90071992547409931234');
  vi.mocked(execFile).mockResolvedValue(result as never);
  const page = await githubCLIService.listAgentIssueEvents({
    repository: 'org/repo',
    repositoryId: '123',
    page: 1,
    perPage: 100,
  });
  expect(page.events[0]?.providerEventId).toBe('90071992547409931234');
});

it.each([
  'https://evil.example/repositories/123/issues/events?per_page=100&page=2',
  'https://api.github.com/repositories/other/issues/events?per_page=100&page=2',
  'https://api.github.com/repositories/123/issues/events?per_page=100&page=1',
])('rejects untrusted pagination %s', async (url) => {
  vi.mocked(execFile).mockResolvedValue(response([event], `<${url}>; rel="next"`) as never);
  await expect(
    githubCLIService.listAgentIssueEvents({
      repository: 'org/repo',
      repositoryId: '123',
      page: 1,
      perPage: 100,
    })
  ).rejects.toThrow();
});

it('rejects malformed executable events and duplicate control identities', async () => {
  for (const rows of [[{ ...event, actor: null }], [event, event]]) {
    vi.mocked(execFile).mockResolvedValue(response(rows) as never);
    await expect(
      githubCLIService.listAgentIssueEvents({
        repository: 'org/repo',
        repositoryId: '123',
        page: 1,
        perPage: 100,
      })
    ).rejects.toThrow();
  }
});

it('resolves canonical repository identity without fetching labels and preserves cancellation', async () => {
  vi.mocked(execFile).mockResolvedValue({
    stdout: JSON.stringify({ id: 123, full_name: 'renamed/repo', has_issues: true }),
    stderr: '',
  } as never);
  const signal = new AbortController().signal;
  expect(await githubCLIService.getAgentRepositoryIdentity('old/repo', signal)).toEqual({
    id: '123',
    name: 'renamed/repo',
  });
  expect(execFile).toHaveBeenCalledOnce();
  expect(execFile).toHaveBeenCalledWith(
    'gh',
    ['api', 'repos/old/repo'],
    expect.objectContaining({ signal })
  );
});

it('shares rate-limit cooldown with other GitHub CLI reads', async () => {
  vi.mocked(execFile).mockRejectedValue(new Error('API rate limit exceeded') as never);
  await expect(
    githubCLIService.listAgentIssueEvents({
      repository: 'org/repo',
      repositoryId: '123',
      page: 1,
      perPage: 100,
    })
  ).rejects.toThrow('rate limit');
  await expect(githubCLIService.getAgentRepositoryIdentity('org/repo')).rejects.toThrow(
    'backing off'
  );
  expect(execFile).toHaveBeenCalledOnce();
});

it('does not spawn a process for an already-aborted source read', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    githubCLIService.listAgentIssueEvents(
      { repository: 'org/repo', repositoryId: '123', page: 1, perPage: 100 },
      controller.signal
    )
  ).rejects.toThrow();
  expect(execFile).not.toHaveBeenCalled();
});
