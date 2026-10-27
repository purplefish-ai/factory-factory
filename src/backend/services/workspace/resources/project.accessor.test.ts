import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/backend/db', () => ({ prisma: { project: { create } } }));
vi.mock('node:child_process', () => {
  throw new Error('resource must not spawn');
});
vi.mock('node:fs/promises', () => {
  throw new Error('resource must not inspect filesystem');
});
vi.mock('@/backend/lib/shell', () => {
  throw new Error('resource must not inspect Git');
});

const data = {
  repoPath: '/repos/demo',
  defaultBranch: 'main',
  githubOwner: null,
  githubRepo: null,
  startupScriptCommand: null,
  startupScriptPath: null,
  startupScriptTimeout: 300,
};
const candidate = (attempt: number) => ({
  name: `Demo ${attempt}`,
  slug: `demo-${attempt}`,
  worktreeBasePath: `/worktrees/demo-${attempt}`,
});
beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: 'project' });
});

describe('project persistence', () => {
  it('allocates all identity fields again after each slug collision', async () => {
    const allocate = vi.fn(candidate);
    create.mockRejectedValueOnce(new Error('Unique constraint failed on slug'));
    await projectAccessor.create(data, allocate);
    expect(allocate.mock.calls).toEqual([[1], [2]]);
    expect(create.mock.calls.map(([input]) => input.data)).toEqual([
      { ...data, ...candidate(1) },
      { ...data, ...candidate(2) },
    ]);
  });
  it('propagates unrelated database failures unchanged', async () => {
    const error = new Error('Unique constraint failed on repoPath');
    create.mockRejectedValue(error);
    await expect(projectAccessor.create(data, candidate)).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('stops after 100 collisions with the historical error', async () => {
    create.mockRejectedValue(new Error('Unique constraint failed on slug'));
    await expect(projectAccessor.create(data, candidate)).rejects.toThrow(
      'Unable to create project: too many projects with similar names'
    );
    expect(create).toHaveBeenCalledTimes(100);
  });
});
