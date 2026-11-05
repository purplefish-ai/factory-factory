import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { gitCommand } from '@/backend/lib/shell';
import { WorkspaceGitStateService } from './workspace-git-state.service';

it.each(['normal', 'no'])(
  'enumerates new files using Git ignore rules with status.showUntrackedFiles=%s',
  async (mode) => {
    const worktreePath = await mkdtemp(path.join(os.tmpdir(), 'ff-untracked-'));
    const service = new WorkspaceGitStateService();
    try {
      const init = await gitCommand(['init', '-b', 'main'], worktreePath);
      expect(init.code).toBe(0);
      await writeFile(path.join(worktreePath, '.gitignore'), '*.log\nnode_modules/\n');
      await gitCommand(['add', '.gitignore'], worktreePath);
      await gitCommand(
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Initial'],
        worktreePath
      );
      await mkdir(path.join(worktreePath, 'new/nested'), { recursive: true });
      await mkdir(path.join(worktreePath, 'new/node_modules'), { recursive: true });
      await writeFile(path.join(worktreePath, 'new/nested/source.ts'), 'export {};');
      await writeFile(path.join(worktreePath, 'new/debug.log'), 'ignored');
      await writeFile(path.join(worktreePath, 'new/node_modules/dependency.js'), 'ignored');
      // Local status configuration must not hide new files from Changes.
      await gitCommand(['config', 'status.showUntrackedFiles', mode], worktreePath);

      const snapshot = await service.getSnapshot({ worktreePath, defaultBranch: 'main' });
      expect(snapshot.status.files).toEqual([
        { path: 'new/nested/source.ts', status: '?', staged: false },
      ]);
    } finally {
      service.stop();
      await rm(worktreePath, { recursive: true, force: true });
    }
  }
);
