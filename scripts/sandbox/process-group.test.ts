import { describe, expect, it } from 'vitest';
import {
  collectGroupProcesses,
  isSandboxProcessGroup,
  parseProcessTable,
  stopProcessGroup,
} from './process-group.mjs';

function fakeSystem(survivesTerm: boolean, survivesKill = false) {
  let processes = [
    { pid: 10, ppid: 1, pgid: 10, zombie: false },
    { pid: 12, ppid: 10, pgid: 12, zombie: false },
  ];
  let time = 0;
  const events: string[] = [];
  return {
    events,
    system: {
      listProcesses: () => processes,
      signal: (target: number, signal: string) => {
        events.push(`${signal} ${target}`);
        if (signal === 'SIGKILL' ? !survivesKill : !survivesTerm) {
          processes = processes.filter((p) => p.pid !== target && -p.pgid !== target);
        }
      },
      sleep: (ms: number) => {
        time += ms;
        return Promise.resolve();
      },
      now: () => time,
      readEnvironment: (pid: number) => (pid === 12 ? 'PATH=/bin\nBASE_DIR=/tmp/sb' : ''),
    },
  };
}

describe('process groups', () => {
  it('collects a process group and the descendants that left it', () => {
    const table = parseProcessTable(
      [
        '  10     1   10 Ss',
        '  11    10   10 S',
        '  12    11   12 S', // provider adapter in its own group
        '  13    12   12 S',
        '  14    10   10 Z', // exited, not yet reaped
        '  20     1   20 S',
      ].join('\n')
    );
    expect([...collectGroupProcesses(table, 10)].sort()).toEqual([10, 11, 12, 13]);
  });

  it('recognises a process group by the BASE_DIR its processes run with', () => {
    const { system } = fakeSystem(false);
    expect(isSandboxProcessGroup(10, '/tmp/sb', system)).toBe(true);
    expect(isSandboxProcessGroup(10, '/tmp/s', system)).toBe(false);
    expect(isSandboxProcessGroup(20, '/tmp/sb', system)).toBe(false);
  });

  it('stops the group with SIGTERM, then SIGKILL, and waits for every process', async () => {
    const polite = fakeSystem(false);
    await stopProcessGroup(10, { system: polite.system });
    expect(polite.events).toEqual(['SIGTERM -10', 'SIGTERM 12']);

    const stubborn = fakeSystem(true);
    await stopProcessGroup(10, { system: stubborn.system, graceMs: 1000 });
    expect(stubborn.events).toEqual([
      'SIGTERM -10',
      'SIGTERM 10',
      'SIGTERM 12',
      'SIGKILL -10',
      'SIGKILL 12',
    ]);

    const unkillable = fakeSystem(true, true);
    await expect(
      stopProcessGroup(10, { system: unkillable.system, graceMs: 1000, killGraceMs: 1000 })
    ).rejects.toThrow('Processes still running after SIGKILL: 10, 12');
  });
});
