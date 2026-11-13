import { describe, expect, it } from 'vitest';
import { startWatchdog, watchdogReason } from './watchdog.mjs';

const T1 = 'Thu Nov 13 10:00:01 2026';
const LATER = 'Thu Nov 13 11:30:00 2026';
const owner = { pid: 300, startedAt: T1 };
const ownerAlive = [{ pid: 300, ppid: 1, pgid: 300, zombie: false, startedAt: T1 }];
const MINUTE = 60_000;

describe('the sandbox watchdog', () => {
  it('stops when the owner process is gone or its pid belongs to another process', () => {
    const base = { now: 0, startedAtMs: 0, ttlMinutes: 0, owner };
    expect(watchdogReason({ ...base, processes: ownerAlive })).toBeNull();
    expect(watchdogReason({ ...base, processes: [] })).toBe('owner process 300 exited');
    expect(
      watchdogReason({ ...base, processes: [{ ...ownerAlive[0], zombie: true }] as never })
    ).toBe('owner process 300 exited');
    expect(
      watchdogReason({ ...base, processes: [{ ...ownerAlive[0], startedAt: LATER }] as never })
    ).toBe('owner process 300 exited');
    expect(watchdogReason({ ...base, owner: null, processes: [] })).toBeNull();
  });

  it('stops after its time to live, unless that is 0', () => {
    const base = { startedAtMs: 1000, owner: null, processes: [] };
    expect(watchdogReason({ ...base, ttlMinutes: 120, now: 1000 + 119 * MINUTE })).toBeNull();
    expect(watchdogReason({ ...base, ttlMinutes: 120, now: 1000 + 120 * MINUTE })).toBe(
      'time to live of 120 minutes reached'
    );
    expect(watchdogReason({ ...base, ttlMinutes: 0, now: 1000 + 10_000 * MINUTE })).toBeNull();
  });

  it('checks on an interval and fires once', () => {
    let time = 0;
    let processes = ownerAlive;
    const ticks: (() => void)[] = [];
    const reasons: string[] = [];
    const stop = startWatchdog({
      owner,
      ttlMinutes: 0,
      startedAtMs: 0,
      system: { listProcesses: () => processes, now: () => time },
      onExpire: (reason: string) => reasons.push(reason),
      setInterval: (tick: () => void) => {
        ticks.push(tick);
        return 1;
      },
      clearInterval: () => undefined,
    });
    ticks[0]?.();
    expect(reasons).toEqual([]);
    processes = [];
    time += 5000;
    ticks[0]?.();
    ticks[0]?.();
    expect(reasons).toEqual(['owner process 300 exited']);
    stop();
  });
});
