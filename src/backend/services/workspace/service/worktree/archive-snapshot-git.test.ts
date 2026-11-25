import { beforeEach, expect, it, vi } from 'vitest';

const mockGitCommand = vi.hoisted(() => vi.fn());
vi.mock('@/backend/lib/shell', () => ({
  gitCommand: (...args: unknown[]) => mockGitCommand(...args),
}));

import { summarizeSnapshotPaths } from './archive-snapshot-git';

const sha = 'a'.repeat(40);

beforeEach(() => {
  mockGitCommand.mockReset();
});

it('keeps a bounded summary when the path list overflows the output buffer', async () => {
  mockGitCommand.mockResolvedValue({
    code: -1,
    stdout: 'D\tone.ts\nD\ttwo.ts\nD\tthr',
    stderr: 'git exceeded maxBuffer',
    stdoutOverflowed: true,
  });

  await expect(summarizeSnapshotPaths('/repo/w1', sha)).resolves.toEqual({
    total: 2,
    byStatus: { D: 2 },
    paths: ['D one.ts', 'D two.ts'],
    truncated: true,
  });
});

it('reports no summary when Git fails for another reason', async () => {
  mockGitCommand.mockResolvedValue({ code: 128, stdout: '', stderr: 'bad object' });

  await expect(summarizeSnapshotPaths('/repo/w1', sha)).resolves.toBeNull();
});
