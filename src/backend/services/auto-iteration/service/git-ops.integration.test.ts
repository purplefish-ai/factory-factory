import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discardUncommittedChanges } from './git-ops';

function git(worktreePath: string, args: string[]): void {
  execFileSync('git', args, { cwd: worktreePath });
}

describe('auto-iteration Git cleanup integration', () => {
  let worktreePath: string;

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'ff-auto-iteration-git-'));
    git(worktreePath, ['init']);
    git(worktreePath, ['config', 'user.email', 'integration@example.com']);
    git(worktreePath, ['config', 'user.name', 'Integration Test']);

    await writeFile(join(worktreePath, 'tracked.txt'), 'committed content\n', 'utf-8');
    git(worktreePath, ['add', 'tracked.txt']);
    git(worktreePath, ['commit', '-m', 'Initial commit']);
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it('preserves Factory Factory runtime files while discarding other uncommitted work', async () => {
    const runtimeDirectory = join(worktreePath, '.factory-factory');
    const nestedRuntimeDirectory = join(runtimeDirectory, 'screenshots');
    const logbookPath = join(runtimeDirectory, 'auto-iteration-logbook.json');
    const screenshotPath = join(nestedRuntimeDirectory, 'iteration.png');
    const untrackedFilePath = join(worktreePath, 'untracked.txt');
    const untrackedDirectory = join(worktreePath, 'untracked-directory');
    const nestedUntrackedFilePath = join(untrackedDirectory, 'draft.txt');

    await writeFile(join(worktreePath, 'tracked.txt'), 'uncommitted content\n', 'utf-8');
    await writeFile(untrackedFilePath, 'discard me\n', 'utf-8');
    await mkdir(untrackedDirectory);
    await writeFile(nestedUntrackedFilePath, 'discard me too\n', 'utf-8');
    await mkdir(nestedRuntimeDirectory, { recursive: true });
    await writeFile(logbookPath, '{"iterations":[]}\n', 'utf-8');
    await writeFile(screenshotPath, 'runtime artifact\n', 'utf-8');
    git(worktreePath, [
      'add',
      '--',
      '.factory-factory/auto-iteration-logbook.json',
      '.factory-factory/screenshots/iteration.png',
    ]);

    await discardUncommittedChanges(worktreePath);

    await expect(readFile(join(worktreePath, 'tracked.txt'), 'utf-8')).resolves.toBe(
      'committed content\n'
    );
    await expect(readFile(untrackedFilePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(nestedUntrackedFilePath, 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(logbookPath, 'utf-8')).resolves.toBe('{"iterations":[]}\n');
    await expect(readFile(screenshotPath, 'utf-8')).resolves.toBe('runtime artifact\n');
  });

  it('does not preserve nested directories that share the runtime directory name', async () => {
    const nestedRuntimeDirectoryPath = join(worktreePath, 'src', '.factory-factory');
    const nestedRuntimeFilePath = join(nestedRuntimeDirectoryPath, 'draft.txt');
    await mkdir(nestedRuntimeDirectoryPath, { recursive: true });
    await writeFile(nestedRuntimeFilePath, 'discard nested implementation artifact\n', 'utf-8');

    await discardUncommittedChanges(worktreePath);

    await expect(readFile(nestedRuntimeFilePath, 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves runtime files when discarding changes before the initial commit', async () => {
    const runtimeDirectory = join(worktreePath, '.factory-factory');
    const runtimeFilePath = join(runtimeDirectory, 'auto-iteration-logbook.json');
    const stagedFilePath = join(worktreePath, 'staged.txt');
    const untrackedFilePath = join(worktreePath, 'untracked.txt');

    git(worktreePath, ['update-ref', '-d', 'HEAD']);
    await mkdir(runtimeDirectory);
    await writeFile(runtimeFilePath, '{"iterations":[]}\n', 'utf-8');
    await writeFile(stagedFilePath, 'discard staged content\n', 'utf-8');
    await writeFile(untrackedFilePath, 'discard untracked content\n', 'utf-8');
    git(worktreePath, ['add', '--', '.factory-factory/auto-iteration-logbook.json', 'staged.txt']);
    await writeFile(runtimeFilePath, '{"iterations":[1]}\n', 'utf-8');
    await writeFile(stagedFilePath, 'discard partially staged content\n', 'utf-8');

    await discardUncommittedChanges(worktreePath);

    await expect(readFile(runtimeFilePath, 'utf-8')).resolves.toBe('{"iterations":[1]}\n');
    await expect(readFile(join(worktreePath, 'tracked.txt'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(stagedFilePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(untrackedFilePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
