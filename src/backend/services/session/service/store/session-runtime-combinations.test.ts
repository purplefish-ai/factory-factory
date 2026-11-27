const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logger }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  SESSION_RUNTIME_ACTIVITIES,
  SESSION_RUNTIME_PHASES,
  SESSION_RUNTIME_PROCESS_STATES,
  type SessionRuntimeState,
} from '@/shared/session-runtime';
import { SessionDomainService } from './session-domain.service';
import {
  combinationOf,
  FLAGGED_LOG_INTERVAL_MS,
  SESSION_RUNTIME_COMBINATIONS,
  SESSION_RUNTIME_SUMMARY_MESSAGE,
  type SessionRuntimeWriter,
  SUMMARY_INTERVAL_MS,
} from './session-runtime-combinations';

const FLAGGED_MESSAGE = 'Session runtime combination flagged';

function snapshot(
  phase: SessionRuntimeState['phase'],
  processState: SessionRuntimeState['processState'],
  activity: SessionRuntimeState['activity']
): SessionRuntimeState {
  return { phase, processState, activity, updatedAt: '2026-11-27T00:00:00.000Z' };
}

function flaggedLines() {
  return logger.warn.mock.calls.filter(([message]) => message === FLAGGED_MESSAGE);
}

function summaryLines() {
  return logger.info.mock.calls.filter(([message]) => message === SESSION_RUNTIME_SUMMARY_MESSAGE);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T00:00:00.000Z'));
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session runtime combination report', () => {
  it('counts each write and logs a meaningless combination once per caller within the interval', () => {
    const domain = new SessionDomainService();

    // A prompt starts, then a runtime error arrives while it is still working:
    // markError keeps the previous process state and activity.
    domain.markRunning('s1');
    domain.markError('s1', 'Provider failed');
    domain.markRunning('s1');
    domain.markError('s1', 'Provider failed again');

    expect(domain.getRuntimeSnapshot('s1')).toMatchObject({
      phase: 'error',
      processState: 'alive',
      activity: 'WORKING',
      errorMessage: 'Provider failed again',
    });
    const report = domain.runtimeCombinations.counts();
    expect(report.combinations).toMatchObject({
      'running/alive/WORKING': 2,
      'error/alive/WORKING': 2,
    });
    expect(report.transitions).toMatchObject({
      'idle/stopped/IDLE -> running/alive/WORKING': 1,
      'running/alive/WORKING -> error/alive/WORKING': 2,
      'error/alive/WORKING -> running/alive/WORKING': 1,
    });
    expect(report.flagged).toEqual([
      {
        combination: 'error/alive/WORKING',
        verdict: 'meaningless',
        caller: 'markError',
        count: 2,
      },
    ]);
    expect(flaggedLines()).toEqual([
      [
        FLAGGED_MESSAGE,
        {
          sessionId: 's1',
          combination: 'error/alive/WORKING',
          verdict: 'meaningless',
          previous: 'running/alive/WORKING',
          caller: 'markError',
          occurrences: 1,
          suppressedSinceLastLog: 0,
        },
      ],
    ]);

    vi.advanceTimersByTime(FLAGGED_LOG_INTERVAL_MS);
    domain.markRunning('s2');
    domain.markError('s2');

    expect(flaggedLines()).toHaveLength(2);
    expect(flaggedLines()[1]?.[1]).toMatchObject({
      sessionId: 's2',
      caller: 'markError',
      occurrences: 3,
      suppressedSinceLastLog: 1,
    });
  });

  it('logs a combination missing from the table and does not change the written runtime', () => {
    const domain = new SessionDomainService();
    const written = snapshot('running', 'stopped', 'WORKING');

    domain.setRuntimeSnapshot('s1', written);

    expect(domain.getRuntimeSnapshot('s1')).toEqual(written);
    expect(flaggedLines()).toEqual([
      [
        FLAGGED_MESSAGE,
        expect.objectContaining({
          sessionId: 's1',
          combination: 'running/stopped/WORKING',
          verdict: 'unlisted',
          previous: 'idle/stopped/IDLE',
          caller: 'setRuntimeSnapshot',
        }),
      ],
    ]);
  });

  it('does not log meaningful combinations from the real writers', () => {
    const domain = new SessionDomainService();

    const release = domain.beginInitialLaunch('s1');
    domain.setRuntimeSnapshot('s1', snapshot('starting', 'alive', 'IDLE'));
    domain.markIdle('s1', 'alive');
    release();
    domain.markRunning('s1');
    domain.setRuntimeSnapshot('s1', { ...snapshot('stopping', 'alive', 'IDLE') });
    domain.markProcessExit('s1', 0);
    domain.setRuntimeSnapshot('s1', snapshot('idle', 'stopped', 'IDLE'));

    expect(flaggedLines()).toEqual([]);
    expect(domain.runtimeCombinations.counts().flagged).toEqual([]);
  });

  it('writes a summary at shutdown and on the slow interval only when the counts changed', () => {
    const domain = new SessionDomainService();

    domain.stopStoreRetention();
    expect(summaryLines()).toEqual([]);

    domain.markRunning('s1');
    domain.stopStoreRetention();
    expect(summaryLines()).toHaveLength(1);
    expect(summaryLines()[0]?.[1]).toMatchObject({
      reason: 'shutdown',
      combinations: { 'running/alive/WORKING': 1 },
    });

    domain.stopStoreRetention();
    expect(summaryLines()).toHaveLength(1);

    vi.advanceTimersByTime(SUMMARY_INTERVAL_MS);
    domain.markIdle('s1', 'alive');
    expect(summaryLines()).toHaveLength(2);
    expect(summaryLines()[1]?.[1]).toMatchObject({ reason: 'interval' });
  });
});

describe('session runtime combination table', () => {
  const entries = Object.entries(SESSION_RUNTIME_COMBINATIONS).map(([combination, entry]) => ({
    combination,
    entry,
    state: z
      .tuple([
        z.enum(SESSION_RUNTIME_PHASES),
        z.enum(SESSION_RUNTIME_PROCESS_STATES),
        z.enum(SESSION_RUNTIME_ACTIVITIES),
      ])
      .parse(combination.split('/')),
  }));
  const listed: string[] = entries.map(({ combination }) => combination);
  const writersOf = (combination: string): readonly string[] =>
    entries.find((listedEntry) => listedEntry.combination === combination)?.entry.writers ?? [];

  function startFrom(combination: string): SessionDomainService {
    const domain = new SessionDomainService();
    const start = entries.find((listedEntry) => listedEntry.combination === combination);
    if (start) {
      domain.setRuntimeSnapshot('s1', snapshot(...start.state));
    }
    return domain;
  }

  /**
   * The table is closed under the store's own writers: from every listed
   * combination, each writer whose result depends on the previous state lands
   * on a listed combination that names that writer. Writers that forward a
   * caller's snapshot (setRuntimeSnapshot, prepareLoad) are covered at run time
   * by the unlisted report instead.
   */
  const storeWriters: [SessionRuntimeWriter, (domain: SessionDomainService) => void][] = [
    ['markRunning', (domain) => domain.markRunning('s1')],
    ['markIdle', (domain) => domain.markIdle('s1', 'alive')],
    ['markIdle', (domain) => domain.markIdle('s1', 'stopped')],
    ['markError', (domain) => domain.markError('s1', 'failed')],
    ['markProcessExit', (domain) => domain.markProcessExit('s1', 0)],
    ['markProcessExit', (domain) => domain.markProcessExit('s1', 1)],
    ['finishLoad', (domain) => domain.finishLoad('s1')],
    ['beginInitialLaunch', (domain) => domain.beginInitialLaunch('s1')],
  ];

  it.each(
    listed.flatMap((start) =>
      storeWriters.map(([writer, write]) => [start, writer, write] as const)
    )
  )('from %s, %s lands on a listed combination', (start, writer, write) => {
    const domain = startFrom(start);
    const before = domain.getRuntimeSnapshot('s1');

    write(domain);

    const after = combinationOf(domain.getRuntimeSnapshot('s1'));
    expect(listed).toContain(after);
    if (after !== combinationOf(before)) {
      expect(writersOf(after)).toContain(writer);
    }
  });

  it('releasing an initial launch restores a listed combination', () => {
    for (const start of listed) {
      const domain = startFrom(start);
      const release = domain.beginInitialLaunch('s1');
      domain.setRuntimeSnapshot('s1', snapshot('starting', 'alive', 'IDLE'));
      domain.markIdle('s1', 'alive');
      release();
      const after = combinationOf(domain.getRuntimeSnapshot('s1'));
      expect(listed).toContain(after);
      expect(writersOf(after)).toContain('releaseInitialLaunch');
    }
  });

  it('gives every listed combination a reason and at least one writer', () => {
    for (const entry of Object.values(SESSION_RUNTIME_COMBINATIONS)) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.writers.length).toBeGreaterThan(0);
    }
  });
});
