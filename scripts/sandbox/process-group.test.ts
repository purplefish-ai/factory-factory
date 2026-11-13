import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  collectGroupProcesses,
  findProcess,
  isSameProcess,
  parseProcessTable,
  realSystem,
  stopProcessGroup,
} from './process-group.mjs';
import { HELPER_LIFETIME_MS } from './test-support';

type Entry = { pid: number; ppid: number; pgid: number; zombie: boolean; startedAt: string };

const T1 = 'Thu Nov 13 10:00:01 2026';
const T2 = 'Thu Nov 13 10:00:02 2026';
const LATER = 'Thu Nov 13 11:30:00 2026';

/**
 * A process table that signals change. `onSignal` decides what a signal does,
 * so a test can make a pid exit and its number be reused by another process.
 */
function fakeSystem(
  initial: Entry[],
  onSignal: (processes: Entry[], target: number, signal: string) => Entry[],
  environments: Record<number, string[]> = {}
) {
  let processes = initial;
  let time = 0;
  const events: string[] = [];
  return {
    events,
    system: {
      listProcesses: () => processes,
      signal: (target: number, signal: string) => {
        events.push(`${signal} ${target}`);
        processes = onSignal(processes, target, signal);
      },
      sleep: (ms: number) => {
        time += ms;
        return Promise.resolve();
      },
      now: () => time,
      processesWithEnvironment: (entry: string, pids: number[] | null) =>
        (pids ?? processes.map((p) => p.pid)).filter((pid) => environments[pid]?.includes(entry)),
    },
  };
}

const server: Entry[] = [
  { pid: 10, ppid: 1, pgid: 10, zombie: false, startedAt: T1 },
  { pid: 12, ppid: 10, pgid: 12, zombie: false, startedAt: T2 },
];
const exitOn =
  (signals: string[]) =>
  (processes: Entry[], target: number, signal: string): Entry[] =>
    signals.includes(signal)
      ? processes.filter((p) => p.pid !== target && -p.pgid !== target)
      : processes;

describe('process identity', () => {
  it('reads environments of listed processes even when some have exited', async () => {
    const entry = 'BASE_DIR=/tmp/ff-sandbox/sb-environment test';
    const env = { PATH: process.env.PATH, BASE_DIR: '/tmp/ff-sandbox/sb-environment test' };
    // Bounded, like every helper process (an interrupted run leaves none behind).
    const live = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${HELPER_LIFETIME_MS})`], {
      env,
    });
    const gone = spawn(process.execPath, ['-e', ''], { env });
    try {
      await new Promise((resolve) => gone.once('exit', resolve));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const livePid = live.pid ?? 0;
      const gonePid = gone.pid ?? 0;
      expect(realSystem.processesWithEnvironment(entry, [livePid, gonePid])).toEqual([livePid]);
      expect(realSystem.processesWithEnvironment(entry, [gonePid])).toEqual([]);
      expect(realSystem.processesWithEnvironment(entry, null)).toEqual([livePid]);
      expect(realSystem.processesWithEnvironment(`${entry}x`, [livePid])).toEqual([]);
    } finally {
      live.kill('SIGKILL');
    }
  }, 30_000);

  it('parses pid, parent, group, state and start time', () => {
    const table = parseProcessTable(
      [`   10     1    10 Ss   ${T1}`, `   14    10    10 Z    ${T2}`, 'garbage', ''].join('\n')
    );
    expect(table).toEqual([
      { pid: 10, ppid: 1, pgid: 10, zombie: false, startedAt: T1 },
      { pid: 14, ppid: 10, pgid: 10, zombie: true, startedAt: T2 },
    ]);
    expect(findProcess(table, 10)?.startedAt).toBe(T1);
    expect(findProcess(table, 14)).toBeNull();
    expect(isSameProcess(table, { pid: 10, startedAt: T1 })).toBe(true);
    expect(isSameProcess(table, { pid: 10, startedAt: LATER })).toBe(false);
  });

  it('reads the same start time under any time zone', () => {
    const original = process.env.TZ;
    const startUnder = (tz: string) => {
      process.env.TZ = tz;
      return findProcess(realSystem.listProcesses(), process.pid)?.startedAt;
    };
    try {
      const pacific = startUnder('America/Los_Angeles');
      expect(pacific).toEqual(expect.any(String));
      expect(startUnder('Asia/Tokyo')).toBe(pacific);
    } finally {
      if (original === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = original;
      }
    }
  });

  it('collects a process group and the descendants that left it', () => {
    const table = parseProcessTable(
      [
        `  10     1   10 Ss ${T1}`,
        `  11    10   10 S  ${T1}`,
        `  12    11   12 S  ${T1}`, // provider adapter in its own group
        `  13    12   12 S  ${T1}`,
        `  14    10   10 Z  ${T1}`, // exited, not yet reaped
        `  20     1   20 S  ${T1}`,
      ].join('\n')
    );
    expect([...collectGroupProcesses(table, 10)].sort()).toEqual([10, 11, 12, 13]);
  });
});

describe('stopping a process group', () => {
  it('stops the group with SIGTERM, then SIGKILL, and waits for every process', async () => {
    const polite = fakeSystem(server, exitOn(['SIGTERM', 'SIGKILL']));
    await stopProcessGroup(10, { system: polite.system, leaderStartedAt: T1 });
    expect(polite.events).toEqual(['SIGTERM -10', 'SIGTERM 12']);

    const stubborn = fakeSystem(server, exitOn(['SIGKILL']));
    await stopProcessGroup(10, { system: stubborn.system, leaderStartedAt: T1, graceMs: 1000 });
    expect(stubborn.events).toEqual([
      'SIGTERM -10',
      'SIGTERM 10',
      'SIGTERM 12',
      'SIGKILL -10',
      'SIGKILL 12',
    ]);

    const unkillable = fakeSystem(server, exitOn([]));
    await expect(
      stopProcessGroup(10, {
        system: unkillable.system,
        leaderStartedAt: T1,
        graceMs: 1000,
        killGraceMs: 1000,
      })
    ).rejects.toThrow('Processes still running after SIGKILL: 10, 12');
  });

  it('leaves a group alone when its leader number now belongs to another process', async () => {
    // The recorded leader started at T1; pid 10 is now a different process.
    const reused = fakeSystem(
      [{ pid: 10, ppid: 1, pgid: 10, zombie: false, startedAt: LATER }],
      exitOn(['SIGTERM', 'SIGKILL'])
    );
    await expect(
      stopProcessGroup(10, { system: reused.system, leaderStartedAt: T1 })
    ).resolves.toEqual({ owned: false });
    expect(reused.events).toEqual([]);
  });

  it('never escalates to a process that took a tracked pid after it exited', async () => {
    // SIGTERM ends the adapter (12) but not the leader; while the leader
    // lingers, pid 12 is reused by an unrelated process outside the group.
    const system = fakeSystem(server, (processes, target, signal) => {
      if (signal === 'SIGTERM' && target === 12) {
        return [
          ...processes.filter((p) => p.pid !== 12),
          { pid: 12, ppid: 1, pgid: 12, zombie: false, startedAt: LATER },
        ];
      }
      return signal === 'SIGKILL' ? processes.filter((p) => p.pgid !== 10) : processes;
    });
    await stopProcessGroup(10, { system: system.system, leaderStartedAt: T1, graceMs: 1000 });
    expect(system.events).toEqual(['SIGTERM -10', 'SIGTERM 10', 'SIGTERM 12', 'SIGKILL -10']);
    expect(system.system.listProcesses()).toEqual([
      { pid: 12, ppid: 1, pgid: 12, zombie: false, startedAt: LATER },
    ]);
  });

  it('treats a reused number as gone when waiting for exit', async () => {
    // The whole group exits on SIGTERM and 12 is reused at once: nothing is left to wait for.
    const system = fakeSystem(server, (processes, target, signal) =>
      signal === 'SIGTERM' && target === -10
        ? [{ pid: 12, ppid: 1, pgid: 99, zombie: false, startedAt: LATER }]
        : processes
    );
    await expect(
      stopProcessGroup(10, { system: system.system, leaderStartedAt: T1, graceMs: 1000 })
    ).resolves.toEqual({ owned: true });
    expect(system.events).toEqual(['SIGTERM -10']);
  });

  const BASE = 'BASE_DIR=/tmp/ff-sandbox/sb-own';

  it('leaves a group alone when its leader is gone and no member is this sandbox', async () => {
    // A stranger double-forked: its group took the number 10 and its leader
    // exited, while its members live on. None runs with this sandbox's BASE_DIR.
    const stranger = fakeSystem(
      [
        { pid: 11, ppid: 1, pgid: 10, zombie: false, startedAt: LATER },
        { pid: 13, ppid: 11, pgid: 10, zombie: false, startedAt: LATER },
      ],
      exitOn(['SIGTERM', 'SIGKILL']),
      { 11: ['BASE_DIR=/tmp/ff-sandbox/sb-other'], 13: [] }
    );
    await expect(
      stopProcessGroup(10, {
        system: stranger.system,
        leaderStartedAt: T1,
        baseDir: '/tmp/ff-sandbox/sb-own',
      })
    ).resolves.toEqual({ owned: false });
    expect(stranger.events).toEqual([]);
  });

  it('stops a group whose leader is gone when a member runs with this sandbox', async () => {
    // The server's leader exited first; Vite (11) and the backend (12) remain.
    const orphaned = fakeSystem(
      [
        { pid: 11, ppid: 1, pgid: 10, zombie: false, startedAt: T2 },
        { pid: 12, ppid: 11, pgid: 10, zombie: false, startedAt: T2 },
      ],
      exitOn(['SIGTERM']),
      { 11: ['PATH=/bin', BASE], 12: [BASE] }
    );
    await expect(
      stopProcessGroup(10, {
        system: orphaned.system,
        leaderStartedAt: T1,
        baseDir: '/tmp/ff-sandbox/sb-own',
      })
    ).resolves.toEqual({ owned: true });
    expect(orphaned.events).toEqual(['SIGTERM -10']);
  });

  it('decides a group recorded without its start time by its members alone', async () => {
    // The launcher recorded the pgid and died before it read the start time.
    const ours = fakeSystem(server, exitOn(['SIGTERM']), { 10: [BASE] });
    await expect(
      stopProcessGroup(10, {
        system: ours.system,
        leaderStartedAt: null,
        baseDir: '/tmp/ff-sandbox/sb-own',
      })
    ).resolves.toEqual({ owned: true });
    expect(ours.events).toEqual(['SIGTERM -10', 'SIGTERM 12']);

    const theirs = fakeSystem(server, exitOn(['SIGTERM']), {});
    await expect(
      stopProcessGroup(10, {
        system: theirs.system,
        leaderStartedAt: null,
        baseDir: '/tmp/ff-sandbox/sb-own',
      })
    ).resolves.toEqual({ owned: false });
    expect(theirs.events).toEqual([]);
  });
});
