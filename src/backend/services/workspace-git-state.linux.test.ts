import { watch } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { gitCommand } from '@/backend/lib/shell';
import { WorkspaceGitStateService } from './workspace-git-state.service';

it.each(['primary', 'linked'])(
  'refreshes nested Linux edits with bounded %s watches',
  async (kind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ff-linux-watches-'));
    const repo = path.join(root, 'repo');
    const worktreePath = kind === 'primary' ? repo : path.join(root, 'linked');
    let now = 0;
    const watched: Array<{ directory: string; recursive: boolean }> = [];
    const service = new WorkspaceGitStateService({
      platform: 'linux',
      now: () => now,
      watchPath: (directory, options, listener) => {
        watched.push({ directory, recursive: options.recursive });
        return watch(directory, options, (event, filename) =>
          listener(event, filename?.toString() ?? null)
        );
      },
    });
    const runGit = async (args: string[]) => {
      const result = await gitCommand(args, repo);
      expect(result.code, result.stderr).toBe(0);
    };
    try {
      await mkdir(path.join(repo, 'apps/web/src'), { recursive: true });
      await runGit(['init', '-b', 'main']);
      await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
      await writeFile(path.join(repo, 'apps/web/src/index.ts'), 'export const value = 1;\n');
      await runGit(['add', '.']);
      await runGit([
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'Initial',
      ]);
      if (kind === 'linked') {
        await runGit(['worktree', 'add', '-b', 'feature', worktreePath]);
      }
      await mkdir(path.join(worktreePath, 'apps/web/node_modules/pkg/node_modules/nested'), {
        recursive: true,
      });
      const input = { worktreePath, defaultBranch: 'main' };
      const first = await service.getSnapshot(input);
      expect(first.status.files).toEqual([]);
      expect(watched).toHaveLength(kind === 'primary' ? 1 : 3);
      expect(watched.every(({ recursive }) => !recursive)).toBe(true);
      expect(watched.some(({ directory }) => directory.includes('node_modules'))).toBe(false);

      await writeFile(
        path.join(worktreePath, 'apps/web/src/index.ts'),
        'export const value = 2;\n'
      );
      await writeFile(
        path.join(worktreePath, 'apps/web/node_modules/pkg/dependency.js'),
        'ignored'
      );
      // No watcher event is required for nested edits: the next polling reader
      // refreshes the snapshot once its bounded cache window expires.
      now += 5000;
      expect(service.getCachedSnapshot(input)).toBeNull();
      const updated = await service.getSnapshot(input);
      expect(updated.status.files).toEqual([
        { path: 'apps/web/src/index.ts', status: 'M', staged: false },
      ]);
      expect(watched).toHaveLength(kind === 'primary' ? 1 : 3);
    } finally {
      service.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
);
