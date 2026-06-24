import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanClaudeWorkspaceCommandsFromDisk } from './slash-command-disk-scanner';

describe('slash command disk scanner', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not scan workspace command directories that resolve outside the worktree', () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-worktree-commands-'));
    const escapedCommandsPath = mkdtempSync(join(tmpdir(), 'ff-escaped-commands-'));
    tempDirs.push(worktreePath, escapedCommandsPath);

    mkdirSync(join(worktreePath, '.claude'), { recursive: true });
    writeFileSync(join(escapedCommandsPath, 'escaped.md'), '---\ndescription: Escaped\n---\n');
    symlinkSync(escapedCommandsPath, join(worktreePath, '.claude', 'commands'));

    expect(scanClaudeWorkspaceCommandsFromDisk(worktreePath)).toEqual([]);
  });
});
