import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanClaudeWorkspaceCommandsFromDisk } from './slash-command-disk-scanner';

function mkfifo(path: string): void {
  const result = spawnSync('mkfifo', [path], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || 'Failed to create FIFO');
  }
}

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

  it('skips non-regular command files before reading descriptions', () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-worktree-commands-'));
    tempDirs.push(worktreePath);

    const commandsPath = join(worktreePath, '.claude', 'commands');
    mkdirSync(commandsPath, { recursive: true });
    writeFileSync(join(commandsPath, 'valid.md'), '---\ndescription: Regular command\n---\n');
    mkfifo(join(commandsPath, 'pipe.md'));

    const commands = scanClaudeWorkspaceCommandsFromDisk(worktreePath);

    expect(commands).toEqual([{ name: 'valid', description: 'Regular command' }]);
  });

  it('skips symlinked command files that resolve to non-regular targets', () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-worktree-commands-'));
    tempDirs.push(worktreePath);

    const commandsPath = join(worktreePath, '.claude', 'commands');
    const fifoPath = join(worktreePath, 'command-target');
    mkdirSync(commandsPath, { recursive: true });
    writeFileSync(join(commandsPath, 'valid.md'), '---\ndescription: Regular command\n---\n');
    mkfifo(fifoPath);
    symlinkSync(fifoPath, join(commandsPath, 'linked.md'));

    const commands = scanClaudeWorkspaceCommandsFromDisk(worktreePath);

    expect(commands).toEqual([{ name: 'valid', description: 'Regular command' }]);
  });
});
