import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPathExists = vi.hoisted(() => vi.fn());
vi.mock('@/backend/lib/file-helpers', () => ({
  pathExists: (...args: unknown[]) => mockPathExists(...args),
}));

import { gitCloneService, parseGithubUrl } from './git-clone.service';

describe('GitHub clone paths on a case-sensitive filesystem', () => {
  let tempDir: string;
  let reposDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'git-clone-casing-'));
    reposDir = join(tempDir, 'repos');
    // macOS can resolve a differently cased path. Require an exact directory
    // entry at every component below our temporary root to simulate Linux.
    mockPathExists.mockImplementation(async (target: string) => {
      let current = tempDir;
      try {
        for (const segment of relative(tempDir, target).split(sep)) {
          if (!(await readdir(current)).includes(segment)) {
            return false;
          }
          current = join(current, segment);
        }
        await stat(current);
        return true;
      } catch {
        return false;
      }
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function createRepo(owner: string, repo: string): Promise<string> {
    const destination = join(reposDir, owner, repo);
    await mkdir(destination, { recursive: true });
    execFileSync('git', ['init', '--quiet', destination]);
    await writeFile(join(destination, 'keep.txt'), 'local changes');
    return destination;
  }

  it.each(['OwNeR/RePo', 'owner/RePo', 'OwNeR/repo'])(
    'reuses the existing %s clone for HTTPS and SSH imports without cloning',
    async (existing) => {
      const [owner, repo] = existing.split('/');
      const destination = await createRepo(owner as string, repo as string);
      const clone = vi.spyOn(gitCloneService, 'clone').mockResolvedValue({
        success: false,
        output: 'Unexpected duplicate clone',
      });
      expect(await mockPathExists(join(reposDir, 'owner', 'repo'))).toBe(false);

      for (const url of ['https://github.com/owner/repo', 'git@github.com:OWNER/REPO.git']) {
        const parsed = parseGithubUrl(url);
        expect(parsed).not.toBeNull();
        const { path: clonePath, status } = await gitCloneService.getClonePath(
          reposDir,
          parsed!.owner,
          parsed!.repo
        );
        if (status === 'not_exists') {
          await gitCloneService.clone(url, clonePath);
        }
        expect(clonePath).toBe(destination);
        expect(status).toBe('valid_repo');
      }

      expect(clone).not.toHaveBeenCalled();
      expect(await readdir(destination)).toContain('keep.txt');
      expect(await readdir(reposDir)).toEqual([owner]);
    }
  );

  it('clones a new repository to a lowercase path and reuses it for another URL casing', async () => {
    const source = join(tempDir, 'source');
    execFileSync('git', ['init', '--quiet', '--bare', source]);
    const parsed = parseGithubUrl('https://github.com/OwNeR/RePo.git');
    const { path: destination, status } = await gitCloneService.getClonePath(
      reposDir,
      parsed!.owner,
      parsed!.repo
    );
    expect(destination).toBe(join(reposDir, 'owner', 'repo'));
    expect(status).toBe('not_exists');
    expect((await gitCloneService.clone(source, destination)).success).toBe(true);
    expect(await gitCloneService.getClonePath(reposDir, 'OWNER', 'REPO')).toEqual({
      path: destination,
      status: 'valid_repo',
    });
    expect(await readdir(reposDir)).toEqual(['owner']);
    expect(await readdir(join(reposDir, 'owner'))).toEqual(['repo']);
  });

  it('uses the canonical path for a new repo even when an older owner directory exists', async () => {
    await createRepo('OwNeR', 'OtherRepo');
    expect(await gitCloneService.getClonePath(reposDir, 'OWNER', 'NewRepo')).toEqual({
      path: join(reposDir, 'owner', 'newrepo'),
      status: 'not_exists',
    });
  });

  it('preserves the non-repository guard for a differently cased existing path', async () => {
    const destination = join(reposDir, 'OwNeR', 'RePo');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'keep.txt'), 'not a repository');
    const resolved = await gitCloneService.getClonePath(reposDir, 'owner', 'repo');
    expect(resolved).toEqual({ path: destination, status: 'not_repo' });
    expect(await readdir(destination)).toEqual(['keep.txt']);
  });
});
