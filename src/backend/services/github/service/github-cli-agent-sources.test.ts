import { execFile } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: (fn: unknown) => fn }));
import { githubCLIService } from './github-cli.service';

beforeEach(() => {
  vi.resetAllMocks();
  githubCLIService.clearCaches();
});

it('reads paginated labels larger than the default exec buffer', async () => {
  const labels = Array.from({ length: 1200 }, (_, index) => ({
    name: `label-${index}`,
    description: 'x'.repeat(1024),
  }));
  vi.mocked(execFile).mockImplementation(((
    command: string,
    args: string[],
    options: { maxBuffer?: number }
  ) => {
    if (command !== 'gh') {
      throw new Error('Unexpected executable');
    }
    const stdout = args[1]?.includes('/labels?')
      ? JSON.stringify([labels])
      : JSON.stringify({ id: 123, full_name: 'owner/.github', has_issues: true });
    if (stdout.length > (options.maxBuffer ?? 1024 * 1024)) {
      return Promise.reject(new Error('maxBuffer exceeded'));
    }
    return Promise.resolve({ stdout, stderr: '' });
  }) as never);
  const result = await githubCLIService.getAgentRepository('owner/.github');
  expect(result).toMatchObject({ id: '123', name: 'owner/.github' });
  expect(result.labels).toHaveLength(1200);
  expect(result.labels[1199]).toBe('label-1199');
});

it('rejects malformed repository owners before invoking gh', async () => {
  vi.mocked(execFile).mockImplementation(() => {
    throw new Error('gh should not run for malformed repository names');
  });
  for (const name of ['-owner/repo', '_owner/repo', 'owner/repo/extra']) {
    await expect(githubCLIService.getAgentRepository(name)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  }
});
