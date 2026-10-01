import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  amendHead,
  commitAll,
  discardUncommittedChanges,
  hasUncommittedChanges,
  revertHead,
} from './git-ops';

function git(worktreePath: string, args: string[]): void {
  execFileSync('git', args, { cwd: worktreePath });
}

const runtimeFiles = [
  'auto-iteration-logbook.json',
  'auto-iteration-insights.md',
  'auto-iteration-strategy.md',
  'screenshots/iteration.png',
];

async function writeRuntimeFiles(worktreePath: string): Promise<void> {
  await mkdir(join(worktreePath, '.factory-factory', 'screenshots'), { recursive: true });
  for (const file of runtimeFiles) {
    await writeFile(join(worktreePath, '.factory-factory', file), `runtime ${file}\n`);
  }
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

  it.each(['untracked', 'staged', 'modified'])(
    'ignores %s runtime files when checking for implementation changes',
    async (state) => {
      await writeRuntimeFiles(worktreePath);
      if (state !== 'untracked') {
        git(worktreePath, ['add', '.factory-factory']);
      }
      if (state === 'modified') {
        git(worktreePath, ['commit', '-m', 'Existing runtime files']);
        await writeFile(
          join(worktreePath, '.factory-factory', runtimeFiles[2]!),
          'edited strategy\n'
        );
      }

      await expect(hasUncommittedChanges(worktreePath)).resolves.toBe(false);
    }
  );

  it.each(['unstaged', 'staged', 'untracked', 'deleted', 'renamed', 'nested', 'similar name'])(
    'detects %s implementation changes alongside runtime files',
    async (state) => {
      await writeRuntimeFiles(worktreePath);
      const trackedPath = join(worktreePath, 'tracked.txt');
      if (state === 'deleted') {
        await rm(trackedPath);
      } else if (state === 'renamed') {
        git(worktreePath, ['mv', 'tracked.txt', 'renamed.txt']);
      } else if (state === 'nested') {
        await mkdir(join(worktreePath, 'src', '.factory-factory'), { recursive: true });
        await writeFile(join(worktreePath, 'src', '.factory-factory', 'code.ts'), 'implementation');
      } else if (state === 'similar name') {
        await mkdir(join(worktreePath, '.factory-factory-code'));
        await writeFile(join(worktreePath, '.factory-factory-code', 'code.ts'), 'implementation');
      } else {
        await writeFile(
          state === 'untracked' ? join(worktreePath, 'new code.ts') : trackedPath,
          'implementation\n'
        );
        if (state === 'staged') {
          git(worktreePath, ['add', 'tracked.txt']);
        }
      }

      await expect(hasUncommittedChanges(worktreePath)).resolves.toBe(true);
    }
  );

  it.each(['commit', 'amend', 'initial commit'])(
    'keeps pre-staged runtime files out of an iteration %s',
    async (operation) => {
      if (operation === 'initial commit') {
        git(worktreePath, ['update-ref', '-d', 'HEAD']);
      }
      await writeRuntimeFiles(worktreePath);
      await writeFile(join(worktreePath, 'tracked.txt'), 'implementation\n');
      git(worktreePath, ['add', '-A']);

      if (operation === 'amend') {
        await amendHead(worktreePath);
      } else {
        await commitAll(worktreePath, 'Iteration');
      }

      expect(
        execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
          cwd: worktreePath,
          encoding: 'utf-8',
        }).trim()
      ).toBe('tracked.txt');
      await expect(hasUncommittedChanges(worktreePath)).resolves.toBe(false);
      for (const file of runtimeFiles) {
        await expect(readFile(join(worktreePath, '.factory-factory', file), 'utf-8')).resolves.toBe(
          `runtime ${file}\n`
        );
      }
    }
  );

  it.each([false, true])(
    'preserves strategy context when reverting code (runtime already tracked: %s)',
    async (trackedRuntime) => {
      await writeRuntimeFiles(worktreePath);
      if (trackedRuntime) {
        git(worktreePath, ['add', '.factory-factory']);
        git(worktreePath, ['commit', '-m', 'Existing runtime files']);
      }
      const strategyPath = join(worktreePath, '.factory-factory', 'auto-iteration-strategy.md');
      await writeFile(strategyPath, 'updated strategy\n');
      await writeFile(join(worktreePath, 'tracked.txt'), 'implementation\n');
      git(worktreePath, ['add', '-A']);

      await commitAll(worktreePath, 'Rejected iteration');
      await revertHead(worktreePath);

      await expect(readFile(strategyPath, 'utf-8')).resolves.toBe('updated strategy\n');
      await expect(readFile(join(worktreePath, 'tracked.txt'), 'utf-8')).resolves.toBe(
        'committed content\n'
      );
      await expect(hasUncommittedChanges(worktreePath)).resolves.toBe(false);
    }
  );

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
