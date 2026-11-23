import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scanClaudeWorkspaceCommandsFromDisk,
  WorkspaceCommandScanCache,
} from './slash-command-disk-scanner';

let worktreePath: string;
let commandsPath: string;
let scan: ReturnType<typeof vi.fn<typeof scanClaudeWorkspaceCommandsFromDisk>>;
let cache: WorkspaceCommandScanCache;

/**
 * Wait until the filesystem clock has moved past the last change of every
 * path, so a change made next gets a later stamp even where timestamps are
 * coarse (Linux uses its tick clock for them).
 */
function afterClockTick(...paths: string[]) {
  const last = paths.map((path) => statSync(path, { bigint: true }).ctimeNs);
  const probe = join(worktreePath, 'clock-probe');
  for (;;) {
    writeFileSync(probe, '');
    const now = statSync(probe, { bigint: true }).ctimeNs;
    if (last.every((ctime) => now > ctime)) {
      return;
    }
  }
}

/** Write a command after the clock ticked past its file and directory. */
function command(path: string, description: string) {
  const file = join(commandsPath, path);
  const existing = [file, join(file, '..')].filter((candidate) => {
    try {
      statSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (existing.length > 0) {
    afterClockTick(...existing);
  }
  writeFileSync(file, `---\ndescription: ${description}\n---\n`);
}

/** Scans run 10 seconds after the fixture's last change, so they are cached. */
const later = () => Date.now() + 10_000;

function names() {
  return cache
    .scan(worktreePath)
    .map((entry) => `${entry.name}=${entry.description}`)
    .sort();
}

beforeEach(() => {
  worktreePath = mkdtempSync(join(tmpdir(), 'ff-command-cache-'));
  commandsPath = join(worktreePath, '.claude', 'commands');
  mkdirSync(join(commandsPath, 'team'), { recursive: true });
  command('deploy.md', 'root');
  command('team/review.md', 'team');
  scan = vi.fn(scanClaudeWorkspaceCommandsFromDisk);
  cache = new WorkspaceCommandScanCache({ scanFromDisk: scan, now: later });
});

afterEach(() => {
  rmSync(worktreePath, { recursive: true, force: true });
});

describe('cached workspace slash command scan', () => {
  it('reads an unchanged workspace once', () => {
    expect(names()).toEqual(['deploy=root', 'team:review=team']);
    expect(names()).toEqual(['deploy=root', 'team:review=team']);
    expect(scan).toHaveBeenCalledOnce();
  });

  it('shows a command added at the top level or in a namespace', () => {
    names();
    command('ship.md', 'new');
    expect(names()).toContain('ship=new');
    command('team/merge.md', 'nested');
    expect(names()).toContain('team:merge=nested');
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it('shows a namespace directory added with its commands', () => {
    names();
    afterClockTick(commandsPath);
    mkdirSync(join(commandsPath, 'ops'));
    command('ops/restart.md', 'ops');
    expect(names()).toContain('ops:restart=ops');
  });

  it('shows an edited description, even with the same size and modification time', () => {
    names();
    const file = join(commandsPath, 'team', 'review.md');
    command('team/review.md', 'TEAM');
    utimesSync(file, 1000, 1000);
    expect(names()).toContain('team:review=TEAM');
    command('team/review.md', 'Team');
    utimesSync(file, 1000, 1000);
    expect(names()).toContain('team:review=Team');
  });

  it('drops a removed command', () => {
    names();
    afterClockTick(join(commandsPath, 'team'));
    unlinkSync(join(commandsPath, 'team', 'review.md'));
    expect(names()).toEqual(['deploy=root']);
  });

  it('shows commands once the commands directory is created', () => {
    rmSync(join(worktreePath, '.claude'), { recursive: true });
    expect(names()).toEqual([]);
    mkdirSync(commandsPath, { recursive: true });
    writeFileSync(join(commandsPath, 'late.md'), '---\ndescription: late\n---\n');
    expect(names()).toEqual(['late=late']);
  });

  it('shows a linked command once its target appears elsewhere in the worktree', () => {
    const shared = join(worktreePath, 'shared');
    mkdirSync(shared);
    afterClockTick(commandsPath);
    symlinkSync(join(shared, 'target.md'), join(commandsPath, 'linked.md'));
    expect(names()).toEqual(['deploy=root', 'team:review=team']);
    writeFileSync(join(shared, 'target.md'), '---\ndescription: later\n---\n');
    expect(names()).toContain('linked=later');
  });

  it('skips names the caller has seen and records the rest, like an uncached scan', () => {
    const seen = new Set(['deploy']);
    expect(cache.scan(worktreePath, seen)).toEqual([{ name: 'team:review', description: 'team' }]);
    expect([...seen].sort()).toEqual(['deploy', 'team:review']);
    expect(cache.scan(worktreePath).map((entry) => entry.name)).toContain('deploy');
  });

  it('returns copies callers may change', () => {
    const first = cache.scan(worktreePath);
    first.push({ name: 'extra', description: '' });
    const [entry] = first;
    if (entry) {
      entry.description = 'changed';
    }
    expect(names()).toEqual(['deploy=root', 'team:review=team']);
  });

  it('rescans the worktree when its path resolves to another root', () => {
    const link = join(worktreePath, 'current');
    const other = join(worktreePath, 'other');
    mkdirSync(join(other, '.claude'), { recursive: true });
    // The other root shares the first root's commands, which lie outside it.
    symlinkSync(commandsPath, join(other, '.claude', 'commands'));
    symlinkSync(worktreePath, link);
    expect(cache.scan(link).map((entry) => entry.name)).toContain('deploy');

    unlinkSync(link);
    symlinkSync(other, link);
    expect(cache.scan(link)).toEqual([]);
  });

  it('rescans while the newest change is too recent to tell a later one apart', () => {
    const recent = new WorkspaceCommandScanCache({ scanFromDisk: scan });
    recent.scan(worktreePath);
    recent.scan(worktreePath);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('returns nothing for a session without a worktree', () => {
    expect(cache.scan(null)).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
  });
});
