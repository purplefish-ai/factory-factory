import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPathSafe } from './file-helpers';

// file-helpers.test.ts mocks node:fs/promises. These cases use the real
// filesystem so symlinks resolve exactly as the kernel resolves them when the
// validated path is later opened.
describe('isPathSafe with real symlinks', () => {
  let root: string;
  let worktree: string;
  let outside: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'ff-ispathsafe-')));
    worktree = path.join(root, 'worktree');
    outside = path.join(root, 'outside');
    await mkdir(worktree);
    await mkdir(path.join(outside, 'deep', 'dir'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a dangling relative symlink reached through a symlinked directory outside the worktree', async () => {
    // worktree/a -> <outside>/deep/dir
    await symlink(path.join(outside, 'deep', 'dir'), path.join(worktree, 'a'));
    // worktree/a/link -> ../secret.txt (dangling; physically <outside>/deep/secret.txt)
    await symlink('../secret.txt', path.join(worktree, 'a', 'link'));

    const safe = await isPathSafe(worktree, 'a/link');

    // Once the target exists, the path reads content from outside the worktree.
    await writeFile(path.join(outside, 'deep', 'secret.txt'), 'outside-secret');
    await expect(readFile(path.join(worktree, 'a', 'link'), 'utf8')).resolves.toBe(
      'outside-secret'
    );
    expect(safe).toBe(false);
  });

  it('rejects a dangling symlink whose target climbs out through a symlinked component', async () => {
    await mkdir(path.join(worktree, 'sub'));
    // worktree/sub/a -> <outside>/deep/dir
    await symlink(path.join(outside, 'deep', 'dir'), path.join(worktree, 'sub', 'a'));
    // worktree/sub/link -> a/../secret.txt (physically <outside>/deep/secret.txt)
    await symlink('a/../secret.txt', path.join(worktree, 'sub', 'link'));

    const safe = await isPathSafe(worktree, 'sub/link');

    await writeFile(path.join(outside, 'deep', 'secret.txt'), 'outside-secret');
    await expect(readFile(path.join(worktree, 'sub', 'link'), 'utf8')).resolves.toBe(
      'outside-secret'
    );
    expect(safe).toBe(false);
  });

  it('allows a dangling relative symlink reached through a symlinked directory inside the worktree', async () => {
    await mkdir(path.join(worktree, 'real', 'dir'), { recursive: true });
    // worktree/a -> worktree/real/dir
    await symlink(path.join(worktree, 'real', 'dir'), path.join(worktree, 'a'));
    // worktree/a/link -> ../new-file.txt (physically worktree/real/new-file.txt)
    await symlink('../new-file.txt', path.join(worktree, 'a', 'link'));

    await expect(isPathSafe(worktree, 'a/link')).resolves.toBe(true);
  });
});
