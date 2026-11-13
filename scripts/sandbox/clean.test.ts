import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanSandboxes, selectSandboxesToClean } from './clean.mjs';
import { findProcess, realSystem } from './process-group.mjs';
import { createSandboxDirectory, readSandboxRecord } from './record.mjs';
import { launch, launcherEnv, spawnSleeper, temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

const T1 = 'Thu Nov 13 10:00:01 2026';
const T2 = 'Thu Nov 13 10:00:02 2026';
const LATER = 'Thu Nov 13 11:30:00 2026';

function recordFor(baseDir: string, fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    baseDir,
    frontendUrl: null,
    backendUrl: null,
    pid: 100,
    pidStartedAt: T1,
    pgid: 4242,
    pgidStartedAt: T2,
    egressPort: null,
    projectId: null,
    repoPath: join(baseDir, 'repo'),
    scenario: 'echo',
    ...fields,
  });
}

type Entry = { pid: number; ppid: number; pgid: number; zombie: boolean; startedAt: string };
/**
 * An injected process table. `environments` gives each pid's environment
 * entries; `exitOnSignal` makes the signalled group or pid exit.
 */
function staticSystem(
  initial: Entry[],
  {
    environments = {},
    exitOnSignal = false,
  }: { environments?: Record<number, string[]>; exitOnSignal?: boolean } = {}
) {
  let processes = initial;
  const events: string[] = [];
  return {
    events,
    system: {
      listProcesses: () => processes,
      signal: (target: number, signal: string) => {
        events.push(`${signal} ${target}`);
        if (exitOnSignal) {
          processes = processes.filter((p) => p.pid !== target && -p.pgid !== target);
        }
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
      processesWithEnvironment: (entry: string, pids: number[] | null) =>
        (pids ?? processes.map((p) => p.pid)).filter(
          (pid) =>
            processes.some((p) => p.pid === pid) && Boolean(environments[pid]?.includes(entry))
        ),
    },
  };
}

/**
 * A detached idle process (its own group) running with `BASE_DIR=<baseDir>`,
 * returned once the process table shows it with that environment (until it
 * has executed, it carries its parent's).
 */
async function spawnSandboxProcess(baseDir: string) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH, BASE_DIR: baseDir },
  });
  const pid = child.pid ?? 0;
  const deadline = Date.now() + 30_000;
  while (realSystem.processesWithEnvironment(`BASE_DIR=${baseDir}`, [pid]).length === 0) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`Process ${pid} never showed BASE_DIR=${baseDir}.`);
    }
    await realSystem.sleep(20);
  }
  return child;
}

describe('--clean selection', () => {
  it('selects only stale sandboxes that name their own directory', () => {
    const root = join(temporary.create('ffsb-'), 'ff-sandbox');
    const dirs = ['stale', 'running', 'other', 'none'].map((name) => join(root, name));
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }
    const [stale, running, other] = dirs as [string, string, string, string];
    writeFileSync(join(stale, 'sandbox.json'), recordFor(stale, { pid: 100 }));
    writeFileSync(join(running, 'sandbox.json'), recordFor(running, { pid: 200 }));
    writeFileSync(join(other, 'sandbox.json'), recordFor(stale, { pid: 100 }));
    symlinkSync(stale, join(root, 'link'));
    const selected = selectSandboxesToClean(root, (record: { pid: number }) => record.pid === 200);
    expect(selected.map((entry: { dir: string }) => entry.dir)).toEqual([stale]);
    expect(readSandboxRecord(join(stale, 'sandbox.json'))?.pgid).toBe(4242);
    expect(selectSandboxesToClean(join(root, 'missing'), () => false)).toEqual([]);
  });

  it('treats a launcher pid now held by another process as not running', async () => {
    const root = join(temporary.create('ffsb-'), 'ff-sandbox');
    const reused = join(root, 'sb-reused');
    const live = join(root, 'sb-live');
    mkdirSync(reused, { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(
      join(reused, 'sandbox.json'),
      recordFor(reused, { pid: 100, pgid: null, pgidStartedAt: null })
    );
    writeFileSync(
      join(live, 'sandbox.json'),
      recordFor(live, { pid: 101, pgid: null, pgidStartedAt: null })
    );
    // pid 100 is someone else now; pid 101 is the same launcher.
    const { system } = staticSystem([
      { pid: 100, ppid: 1, pgid: 100, zombie: false, startedAt: LATER },
      { pid: 101, ppid: 1, pgid: 101, zombie: false, startedAt: T1 },
    ]);
    const removed: string[] = [];
    await cleanSandboxes({
      root,
      tempDir: join(root, '..'),
      system,
      remove: (dir: string) => removed.push(dir),
    });
    expect(removed).toEqual([reused]);
  });

  it('removes a sandbox whose launcher died before it started a server', async () => {
    const tempDir = temporary.create('ffsb-');
    const root = join(tempDir, 'ff-sandbox');
    mkdirSync(root);
    // The provisional record a launcher writes straight after mkdtemp.
    const dir = createSandboxDirectory(root, { pid: 100, startedAt: T1 }, 'echo');
    const record = readSandboxRecord(join(dir, 'sandbox.json'));
    expect(record).toMatchObject({ baseDir: dir, pid: 100, pgid: null, pgidStartedAt: null });
    const { system, events } = staticSystem([]);
    const removed = await cleanSandboxes({ root, tempDir, system });
    expect(removed).toEqual([dir]);
    expect(events).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('cleans a record written between spawning the server and reading its start time', async () => {
    const tempDir = temporary.create('ffsb-');
    const dir = join(tempDir, 'ff-sandbox', 'sb-between');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sandbox.json'), recordFor(dir, { pgid: 4242, pgidStartedAt: null }));
    // The launcher (100) is dead; its server group lives and carries its BASE_DIR.
    const { system, events } = staticSystem(
      [
        { pid: 4242, ppid: 1, pgid: 4242, zombie: false, startedAt: T2 },
        { pid: 4243, ppid: 4242, pgid: 4242, zombie: false, startedAt: T2 },
      ],
      { environments: { 4242: [`BASE_DIR=${dir}`], 4243: [`BASE_DIR=${dir}`] }, exitOnSignal: true }
    );
    const removed = await cleanSandboxes({ root: join(tempDir, 'ff-sandbox'), tempDir, system });
    expect(events).toEqual(['SIGTERM -4242']);
    expect(removed).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  it('signals and deletes nothing when the process table cannot be read', async () => {
    const tempDir = temporary.create('ffsb-');
    const root = join(tempDir, 'ff-sandbox');
    const dir = join(root, 'sb-unreadable');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sandbox.json'), recordFor(dir, { pgid: 4242, pgidStartedAt: T2 }));
    const { system, events } = staticSystem([]);
    const removed: string[] = [];
    await expect(
      cleanSandboxes({
        root,
        tempDir,
        system: {
          ...system,
          listProcesses: () => {
            throw new Error('spawn ps EAGAIN');
          },
        },
        remove: (path: string) => removed.push(path),
      })
    ).rejects.toThrow('spawn ps EAGAIN');
    expect(events).toEqual([]);
    expect(removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('never deletes a directory while a live process runs with it as BASE_DIR', async () => {
    const tempDir = temporary.create('ffsb-');
    const root = join(tempDir, 'ff-sandbox');
    const dir = join(root, 'sb-in-use');
    mkdirSync(dir, { recursive: true });
    // No group recorded (the launcher died before the second write), yet pid
    // 4300 runs with this BASE_DIR; 4301 runs with another sandbox's.
    writeFileSync(join(dir, 'sandbox.json'), recordFor(dir, { pgid: null, pgidStartedAt: null }));
    const { system, events } = staticSystem(
      [
        { pid: 4300, ppid: 1, pgid: 4300, zombie: false, startedAt: T2 },
        { pid: 4301, ppid: 1, pgid: 4301, zombie: false, startedAt: T2 },
      ],
      { environments: { 4300: [`BASE_DIR=${dir}`], 4301: [`BASE_DIR=${dir}-other`] } }
    );
    const logs: string[] = [];
    const removed: string[] = [];
    await expect(
      cleanSandboxes({
        root,
        tempDir,
        system,
        remove: (path: string) => removed.push(path),
        log: (text: string) => logs.push(text),
      })
    ).rejects.toThrow(`Left 1 sandbox directory in use: ${dir}`);
    expect(removed).toEqual([]);
    expect(events).toEqual([]);
    expect(logs).toContain(`Leaving ${dir}: processes 4300 still run with it as BASE_DIR`);
  });
});

describe('--clean on real directories', () => {
  it('--clean ignores a directory without a sandbox.json naming itself', async () => {
    const tempDir = temporary.create('ffsb-');
    const root = join(tempDir, 'ff-sandbox');
    const sleeper = spawnSleeper();
    try {
      const pgid = sleeper.pid ?? 0;
      const sleeperStart = findProcess(realSystem.listProcesses(), pgid)?.startedAt;
      const noRecord = join(root, 'sb-none');
      const elsewhere = join(root, 'sb-elsewhere');
      const broken = join(root, 'sb-broken');
      for (const dir of [noRecord, elsewhere, broken]) {
        mkdirSync(dir, { recursive: true });
      }
      // A dead launcher, naming another directory and a live process group.
      writeFileSync(
        join(elsewhere, 'sandbox.json'),
        recordFor(noRecord, { pid: pgid, pidStartedAt: T1, pgid, pgidStartedAt: sleeperStart })
      );
      writeFileSync(join(broken, 'sandbox.json'), '{');
      const clean = launch(['--clean'], launcherEnv(tempDir));
      expect(await clean.exited).toBe(0);
      expect([noRecord, elsewhere, broken].map((dir) => existsSync(dir))).toEqual([
        true,
        true,
        true,
      ]);
      expect(sleeper.exitCode).toBeNull();
    } finally {
      sleeper.kill('SIGKILL');
    }
  }, 30_000);

  it('removes a stale sandbox without signalling a group that is no longer its own', async () => {
    const tempDir = temporary.create('ffsb-');
    const dir = join(tempDir, 'ff-sandbox', 'sb-stale');
    mkdirSync(dir, { recursive: true });
    // An unrelated process group that happens to carry the recorded ID; the
    // recorded leader started at another time.
    const unrelated = spawnSleeper();
    try {
      writeFileSync(
        join(dir, 'sandbox.json'),
        recordFor(dir, {
          pid: unrelated.pid,
          pidStartedAt: T1,
          pgid: unrelated.pid,
          pgidStartedAt: T2,
        })
      );
      const clean = launch(['--clean'], launcherEnv(tempDir));
      expect(await clean.exited).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(findProcess(realSystem.listProcesses(), unrelated.pid ?? 0)).not.toBeNull();
      expect(clean.output()).toContain('no longer belongs');
    } finally {
      unrelated.kill('SIGKILL');
    }
  }, 30_000);

  it('--clean stops a server group recorded without its start time', async () => {
    const tempDir = temporary.create('ffsb-');
    const dir = join(tempDir, 'ff-sandbox', 'sb-between');
    mkdirSync(dir, { recursive: true });
    const server = await spawnSandboxProcess(dir);
    try {
      const pid = server.pid ?? 0;
      // A dead launcher (a live pid with another start time) that recorded only the pgid.
      writeFileSync(
        join(dir, 'sandbox.json'),
        recordFor(dir, { pid, pidStartedAt: T1, pgid: pid, pgidStartedAt: null })
      );
      const clean = launch(['--clean'], launcherEnv(tempDir));
      expect(await clean.exited).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(findProcess(realSystem.listProcesses(), pid)).toBeNull();
    } finally {
      server.kill('SIGKILL');
    }
  }, 60_000);

  it('--clean leaves a directory a live process still runs with, naming it', async () => {
    const tempDir = temporary.create('ffsb-');
    const dir = join(tempDir, 'ff-sandbox', 'sb-in-use');
    mkdirSync(dir, { recursive: true });
    const user = await spawnSandboxProcess(dir);
    try {
      writeFileSync(join(dir, 'sandbox.json'), recordFor(dir, { pgid: null, pgidStartedAt: null }));
      const clean = launch(['--clean'], launcherEnv(tempDir));
      expect(await clean.exited).toBe(1);
      expect(existsSync(dir)).toBe(true);
      expect(clean.output()).toContain(
        `Leaving ${dir}: processes ${user.pid} still run with it as BASE_DIR`
      );
      expect(findProcess(realSystem.listProcesses(), user.pid ?? 0)).not.toBeNull();
    } finally {
      user.kill('SIGKILL');
    }
  }, 60_000);
});

describe('sandbox.json', () => {
  it('rejects a record without the identity fields', () => {
    const dir = temporary.create('ffsb-');
    const file = join(dir, 'sandbox.json');
    writeFileSync(file, recordFor(dir, { pidStartedAt: undefined }));
    expect(readSandboxRecord(file)).toBeNull();
    // A start time needs its group; a group recorded before its start time is valid.
    writeFileSync(file, recordFor(dir, { pgid: null, pgidStartedAt: T2 }));
    expect(readSandboxRecord(file)).toBeNull();
    writeFileSync(file, recordFor(dir, { pgid: 7, pgidStartedAt: null }));
    expect(readSandboxRecord(file)).toMatchObject({ pgid: 7, pgidStartedAt: null });
    writeFileSync(file, recordFor(dir));
    expect(JSON.parse(readFileSync(file, 'utf8')).pgid).toBe(4242);
    expect(readSandboxRecord(file)?.pidStartedAt).toBe(T1);
  });
});
