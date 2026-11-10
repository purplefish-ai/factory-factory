import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isProcessRunning } from './process-liveness';
import {
  isPathInsideRoot,
  type ListedProcess,
  parseDarwinPs,
  parseLinuxStat,
  parseLsofCwd,
  platformProcessLister,
  resolveWorktreeRoots,
  selectWorktreeProcesses,
  sweepWorktreeProcesses,
} from './worktree-process-sweep';

const ROOT = '/base/workspace-abc';
const SELF = { pid: 500, uid: 501 };

function proc(overrides: Partial<ListedProcess> & { pid: number }): ListedProcess {
  return { ppid: 1, uid: 501, hasTty: false, ...overrides };
}

describe('isPathInsideRoot', () => {
  it('matches the root and descendants on a path boundary only', () => {
    expect(isPathInsideRoot(ROOT, ROOT)).toBe(true);
    expect(isPathInsideRoot(`${ROOT}/node_modules/.bin/esbuild`, ROOT)).toBe(true);
    expect(isPathInsideRoot('/base/workspace-abcd', ROOT)).toBe(false);
    expect(isPathInsideRoot('/base/workspace-abcd/src', ROOT)).toBe(false);
    expect(isPathInsideRoot('/base', ROOT)).toBe(false);
  });

  it('rejects relative, missing, traversal and deleted-path spellings', () => {
    expect(isPathInsideRoot('workspace-abc', ROOT)).toBe(false);
    expect(isPathInsideRoot(undefined, ROOT)).toBe(false);
    expect(isPathInsideRoot(`${ROOT}/../workspace-abcd`, ROOT)).toBe(false);
    expect(isPathInsideRoot(`${ROOT} (deleted)`, ROOT)).toBe(false);
  });
});

describe('selectWorktreeProcesses', () => {
  it('matches by working directory or executable inside the worktree', () => {
    const selected = selectWorktreeProcesses(
      [
        proc({ pid: 10, cwd: ROOT }),
        proc({ pid: 11, cwd: '/', executable: `${ROOT}/node_modules/esbuild/bin/esbuild` }),
        proc({ pid: 12, cwd: '/base/workspace-abcd', executable: '/usr/bin/node' }),
        proc({ pid: 13, cwd: '/Users/me', executable: '/Applications/Editor' }),
      ],
      [ROOT],
      SELF
    );

    expect(selected).toEqual([10, 11]);
  });

  it('never selects PID 0/1, the server, its ancestors, other users or terminal processes', () => {
    const selected = selectWorktreeProcesses(
      [
        proc({ pid: 0, ppid: 0, cwd: ROOT }),
        proc({ pid: 1, ppid: 0, cwd: ROOT }),
        proc({ pid: 100, ppid: 1, cwd: ROOT }),
        proc({ pid: 200, ppid: 100, cwd: ROOT }),
        proc({ pid: 500, ppid: 200, cwd: ROOT }),
        proc({ pid: 600, ppid: 1, cwd: ROOT, uid: 0 }),
        proc({ pid: 700, ppid: 1, cwd: ROOT, hasTty: true }),
        proc({ pid: 800, ppid: 500, cwd: ROOT }),
      ],
      [ROOT],
      { ...SELF, ppid: 200 }
    );

    expect(selected).toEqual([800]);
  });

  it('protects the parent PID even when the listing misses it', () => {
    expect(
      selectWorktreeProcesses([proc({ pid: 42, cwd: ROOT })], [ROOT], { ...SELF, ppid: 42 })
    ).toEqual([]);
  });
});

describe('resolveWorktreeRoots', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'ff-sweep-roots-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('returns lexical and real spellings for an existing worktree', async () => {
    await mkdir(path.join(base, 'workspace-abc'));
    const realBase = await realpath(base);

    const roots = await resolveWorktreeRoots(path.join(base, 'workspace-abc'), base);

    expect(roots).toContain(path.join(base, 'workspace-abc'));
    expect(roots).toContain(path.join(realBase, 'workspace-abc'));
  });

  it('keeps a removed worktree relative to the real base', async () => {
    const realBase = await realpath(base);

    await expect(resolveWorktreeRoots(path.join(base, 'workspace-gone'), base)).resolves.toContain(
      path.join(realBase, 'workspace-gone')
    );
  });

  it('rejects the base itself, paths outside it, relative paths and symlinked worktrees', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'ff-sweep-outside-'));
    try {
      await symlink(outside, path.join(base, 'workspace-link'));

      await expect(resolveWorktreeRoots(base, base)).rejects.toThrow(/outside/);
      await expect(resolveWorktreeRoots(`${base}-sibling/workspace-a`, base)).rejects.toThrow(
        /outside/
      );
      await expect(resolveWorktreeRoots(path.join(base, '..', 'x'), base)).rejects.toThrow(
        /outside/
      );
      await expect(resolveWorktreeRoots('workspace-a', base)).rejects.toThrow(/absolute/);
      await expect(resolveWorktreeRoots(path.join(base, 'workspace-link'), base)).rejects.toThrow(
        /symbolic link/
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('process listing parsers', () => {
  it('parses macOS ps rows with spaces in the executable path', () => {
    expect(
      parseDarwinPs(
        '    1     0     0 ??       /sbin/launchd\n' +
          '  130 99538   501 ??       /Users/me/Application Support/w/bin/esbuild\n' +
          '  777   776   501 ttys003  -zsh\n'
      )
    ).toEqual([
      { pid: 1, ppid: 0, uid: 0, hasTty: false, executable: '/sbin/launchd' },
      {
        pid: 130,
        ppid: 99_538,
        uid: 501,
        hasTty: false,
        executable: '/Users/me/Application Support/w/bin/esbuild',
      },
      { pid: 777, ppid: 776, uid: 501, hasTty: true, executable: '-zsh' },
    ]);
  });

  it('parses lsof cwd fields', () => {
    expect(parseLsofCwd('p103\nfcwd\nn/\np130\nfcwd\nn/base/workspace abc\n')).toEqual(
      new Map([
        [103, '/'],
        [130, '/base/workspace abc'],
      ])
    );
  });

  it('parses Linux stat with a command name containing parentheses and spaces', () => {
    expect(parseLinuxStat('42 (node (x) y) S 7 42 42 0 -1 4194560')).toEqual({
      ppid: 7,
      ttyNr: 0,
    });
    expect(parseLinuxStat('garbage')).toBeUndefined();
  });

  it('is unavailable on unsupported platforms or without a user id', () => {
    expect(platformProcessLister('win32', 501)).toBeNull();
    expect(platformProcessLister('darwin', undefined)).toBeNull();
  });
});

describe('sweepWorktreeProcesses with an injected lister', () => {
  let base: string;
  let worktree: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'ff-sweep-unit-')));
    worktree = path.join(base, 'workspace-abc');
    await mkdir(worktree);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function fakeProcesses(initial: ListedProcess[], options: { ignoreTerm?: boolean } = {}) {
    const alive = new Map(initial.map((entry) => [entry.pid, entry]));
    const signals: [number, NodeJS.Signals | 0][] = [];
    const signal = (pid: number, value: NodeJS.Signals | 0) => {
      if (!alive.has(pid)) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      signals.push([pid, value]);
      if (value === 'SIGKILL' || (value === 'SIGTERM' && !options.ignoreTerm)) {
        alive.delete(pid);
      }
    };
    return { alive, signals, signal, listProcesses: async () => [...alive.values()] };
  }

  const sweepOptions = () => ({
    worktreePath: worktree,
    worktreeBasePath: base,
    selfPid: 500,
    selfUid: 501,
    serverCwd: '/srv',
    termGraceMs: 20,
    killGraceMs: 20,
  });

  it('is a no-op when identification is unavailable', async () => {
    await expect(
      sweepWorktreeProcesses({ ...sweepOptions(), listProcesses: null })
    ).resolves.toEqual({ status: 'unsupported' });
  });

  it('terminates only matching processes', async () => {
    const fake = fakeProcesses([
      proc({ pid: 10, cwd: worktree }),
      proc({ pid: 11, cwd: `${worktree}d` }),
      proc({ pid: 500, ppid: 1, cwd: worktree }),
    ]);

    const result = await sweepWorktreeProcesses({ ...sweepOptions(), ...fake });

    expect(result).toEqual({
      status: 'swept',
      matched: [10],
      terminated: [10],
      killed: [],
      survivors: [],
    });
    expect(fake.signals.filter(([, value]) => value !== 0)).toEqual([[10, 'SIGTERM']]);
  });

  it('escalates to SIGKILL only for processes that still match after the grace period', async () => {
    const fake = fakeProcesses(
      [proc({ pid: 10, cwd: worktree }), proc({ pid: 11, cwd: worktree })],
      { ignoreTerm: true }
    );
    const originalList = fake.listProcesses;
    let listings = 0;
    // PID 11 is reused by an unrelated process before the second listing.
    fake.listProcesses = async () => {
      listings++;
      const processes = await originalList();
      return listings === 1
        ? processes
        : processes.map((entry) => (entry.pid === 11 ? { ...entry, cwd: '/elsewhere' } : entry));
    };

    const result = await sweepWorktreeProcesses({ ...sweepOptions(), ...fake });

    expect(result).toMatchObject({ matched: [10, 11], killed: [10], survivors: [] });
    expect(fake.signals).not.toContainEqual([11, 'SIGKILL']);
    expect(fake.alive.has(11)).toBe(true);
  });

  it('refuses to sweep a worktree containing the server working directory', async () => {
    const fake = fakeProcesses([proc({ pid: 10, cwd: worktree })]);

    await expect(
      sweepWorktreeProcesses({ ...sweepOptions(), ...fake, serverCwd: `${worktree}/server` })
    ).rejects.toThrow(/server working directory/);
    expect(fake.signals).toEqual([]);
  });

  it('bounds a stalled listing', async () => {
    await expect(
      sweepWorktreeProcesses({
        ...sweepOptions(),
        listTimeoutMs: 20,
        listProcesses: () => new Promise<ListedProcess[]>(() => undefined),
      })
    ).rejects.toThrow(/timed out/);
  });
});

const realProcessesSupported = process.platform === 'darwin' || process.platform === 'linux';

describe.runIf(realProcessesSupported)('sweepWorktreeProcesses with real processes', () => {
  let base: string;
  const spawnedPids: number[] = [];

  beforeEach(async () => {
    // Deliberately not realpath-resolved: macOS temp paths sit behind a symlink.
    base = await mkdtemp(path.join(tmpdir(), 'ff-sweep-real-'));
    await mkdir(path.join(base, 'workspace-abc'));
    await mkdir(path.join(base, 'workspace-abcd'));
  });

  afterEach(async () => {
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(base, { recursive: true, force: true });
  });

  /** Starts a background process whose launching shell exits, as an agent's would. */
  async function spawnDetachedOrphan(cwd: string, ignoreTerm = false): Promise<number> {
    const trap = ignoreTerm ? "trap '' TERM; " : '';
    const shell = spawn('sh', ['-c', `(${trap}exec sleep 300) >/dev/null 2>&1 & echo $!`], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    shell.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
      shell.once('error', reject);
      shell.once('close', () => resolve());
    });
    const pid = Number(stdout.trim());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    spawnedPids.push(pid);
    return pid;
  }

  it('terminates an orphaned child in the worktree and spares a sibling-prefix worktree', async () => {
    const target = await spawnDetachedOrphan(path.join(base, 'workspace-abc'));
    const sibling = await spawnDetachedOrphan(path.join(base, 'workspace-abcd'));

    const result = await sweepWorktreeProcesses({
      worktreePath: path.join(base, 'workspace-abc'),
      worktreeBasePath: base,
    });

    expect(result).toMatchObject({ status: 'swept', matched: [target], survivors: [] });
    expect(await isProcessRunning(target)).toBe(false);
    expect(await isProcessRunning(sibling)).toBe(true);
  }, 20_000);

  it('kills a child that ignores SIGTERM after the grace period', async () => {
    const stubborn = await spawnDetachedOrphan(path.join(base, 'workspace-abc'), true);

    const result = await sweepWorktreeProcesses({
      worktreePath: path.join(base, 'workspace-abc'),
      worktreeBasePath: base,
      termGraceMs: 200,
    });

    expect(result).toMatchObject({ status: 'swept', killed: [stubborn], survivors: [] });
    expect(await isProcessRunning(stubborn)).toBe(false);
  }, 20_000);
});
