import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resumeModesSchema } from '@/shared/schemas/persisted-stores.schema';
import {
  assertWorktreePathSafe,
  WorktreePathSafetyError,
  worktreeLifecycleService,
} from './worktree-lifecycle.service';

describe('worktreeLifecycleService path safety', () => {
  it('allows worktree paths under the base path', () => {
    expect(() => assertWorktreePathSafe('/tmp/worktrees/ws-1', '/tmp/worktrees')).not.toThrow();
  });

  it('rejects worktree paths that equal the base path', () => {
    expect(() => assertWorktreePathSafe('/tmp/worktrees', '/tmp/worktrees')).toThrow(
      WorktreePathSafetyError
    );
  });

  it('rejects worktree paths outside the base path', () => {
    expect(() => assertWorktreePathSafe('/tmp/worktrees/../other', '/tmp/worktrees')).toThrow(
      WorktreePathSafetyError
    );
  });
});

describe('worktreeLifecycleService resume mode persistence', () => {
  it('persists concurrent resume mode writes without dropping entries', async () => {
    const worktreeBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-resume-'));
    try {
      await Promise.all([
        worktreeLifecycleService.setInitMode('workspace-1', true, worktreeBasePath),
        worktreeLifecycleService.setInitMode('workspace-2', true, worktreeBasePath),
      ]);

      const filePath = path.join(worktreeBasePath, '.ff-resume-modes.json');
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const data = resumeModesSchema.parse(parsed);

      expect(data['workspace-1']).toBe(true);
      expect(data['workspace-2']).toBe(true);
    } finally {
      await fs.rm(worktreeBasePath, { recursive: true, force: true });
    }
  });

  it('handles malformed resume modes JSON gracefully', async () => {
    const worktreeBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-resume-'));
    try {
      const filePath = path.join(worktreeBasePath, '.ff-resume-modes.json');
      await fs.writeFile(filePath, '{"invalid": "not a boolean"}', 'utf-8');

      await worktreeLifecycleService.setInitMode('workspace-1', true, worktreeBasePath);

      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const data = resumeModesSchema.parse(parsed);

      expect(data['workspace-1']).toBe(true);
    } finally {
      await fs.rm(worktreeBasePath, { recursive: true, force: true });
    }
  });

  it('handles corrupted JSON gracefully', async () => {
    const worktreeBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-resume-'));
    try {
      const filePath = path.join(worktreeBasePath, '.ff-resume-modes.json');
      await fs.writeFile(filePath, '{invalid json', 'utf-8');

      await worktreeLifecycleService.setInitMode('workspace-1', true, worktreeBasePath);

      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const data = resumeModesSchema.parse(parsed);

      expect(data['workspace-1']).toBe(true);
    } finally {
      await fs.rm(worktreeBasePath, { recursive: true, force: true });
    }
  });

  it('handles non-object JSON gracefully', async () => {
    const worktreeBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-resume-'));
    try {
      const filePath = path.join(worktreeBasePath, '.ff-resume-modes.json');
      await fs.writeFile(filePath, '["array", "not", "object"]', 'utf-8');

      await worktreeLifecycleService.setInitMode('workspace-1', true, worktreeBasePath);

      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const data = resumeModesSchema.parse(parsed);

      expect(data['workspace-1']).toBe(true);
    } finally {
      await fs.rm(worktreeBasePath, { recursive: true, force: true });
    }
  });
});
