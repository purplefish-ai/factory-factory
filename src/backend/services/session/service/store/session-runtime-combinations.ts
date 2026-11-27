import { createLogger } from '@/backend/services/logger.service';
import type {
  SessionRuntimeActivity,
  SessionRuntimePhase,
  SessionRuntimeProcessState,
  SessionRuntimeState,
} from '@/shared/session-runtime';

/**
 * Observation only: which (phase, process state, activity) combinations the
 * runtime writers produce. Nothing here rejects or changes a write; the counts
 * are evidence for deciding whether the runtime needs a real state machine.
 */

/** The `SessionDomainService` entry point behind each `markRuntime` call. */
export const SESSION_RUNTIME_WRITERS = [
  'markRunning',
  'markIdle',
  'markError',
  'markProcessExit',
  'prepareLoad',
  'finishLoad',
  'setRuntimeSnapshot',
  'beginInitialLaunch',
  'releaseInitialLaunch',
] as const;

export type SessionRuntimeWriter = (typeof SESSION_RUNTIME_WRITERS)[number];
type ReportedCaller = SessionRuntimeWriter | 'unlabelled';

export type SessionRuntimeCombination =
  `${SessionRuntimePhase}/${SessionRuntimeProcessState}/${SessionRuntimeActivity}`;

type CombinationEntry = {
  readonly verdict: 'meaningful' | 'meaningless' | 'undecided';
  readonly reason: string;
  /** Writers that can produce it, read from their call sites. */
  readonly writers: readonly SessionRuntimeWriter[];
};

/**
 * Every combination the writers can produce today. `setRuntimeSnapshot` and
 * `prepareLoad` forward a snapshot their caller built (`prepareLoad` gets the
 * lifecycle service's derived runtime), so they are listed wherever one of
 * those callers or that derivation produces the combination. A combination
 * missing from this table is reported as unlisted.
 */
export const SESSION_RUNTIME_COMBINATIONS = {
  'idle/stopped/IDLE': {
    verdict: 'meaningful',
    reason: 'No process: a new store, a clean exit or a finished stop.',
    writers: [
      'markIdle',
      'markProcessExit',
      'setRuntimeSnapshot',
      'prepareLoad',
      'releaseInitialLaunch',
    ],
  },
  'idle/alive/IDLE': {
    verdict: 'meaningful',
    reason: 'A live process waiting for a prompt.',
    writers: ['markIdle', 'setRuntimeSnapshot', 'prepareLoad', 'releaseInitialLaunch'],
  },
  'starting/unknown/IDLE': {
    verdict: 'meaningful',
    reason: 'An initial launch is provisioning the workspace before any process exists.',
    writers: ['beginInitialLaunch'],
  },
  'starting/alive/IDLE': {
    verdict: 'meaningful',
    reason:
      'The process is installed and being configured, or an initial launch shows its idle process as starting.',
    writers: ['markIdle', 'setRuntimeSnapshot', 'prepareLoad', 'releaseInitialLaunch'],
  },
  'running/alive/WORKING': {
    verdict: 'meaningful',
    reason: 'A prompt or background task is in flight on a live process.',
    writers: ['markRunning', 'setRuntimeSnapshot', 'prepareLoad'],
  },
  'stopping/alive/IDLE': {
    verdict: 'meaningful',
    reason: 'A stop was requested and the process has not exited yet.',
    writers: ['setRuntimeSnapshot', 'prepareLoad'],
  },
  'stopping/stopped/IDLE': {
    verdict: 'meaningful',
    reason: 'A stop of a session whose process already exited; its cleanup is still running.',
    writers: ['setRuntimeSnapshot', 'prepareLoad'],
  },
  'stopping/unknown/IDLE': {
    verdict: 'meaningful',
    reason: 'A stop requested while an initial launch had no process yet.',
    writers: ['setRuntimeSnapshot', 'prepareLoad'],
  },
  'stopping/alive/WORKING': {
    verdict: 'meaningless',
    reason:
      'A stop always writes IDLE; the read path copies a stale WORKING into stopping when the handle is gone first.',
    writers: ['prepareLoad'],
  },
  'error/stopped/IDLE': {
    verdict: 'meaningful',
    reason: 'Startup failed or the process exited unexpectedly.',
    writers: ['markError', 'markProcessExit', 'setRuntimeSnapshot', 'prepareLoad'],
  },
  'error/alive/IDLE': {
    verdict: 'meaningful',
    reason: 'A prompt failed and the process survived it.',
    writers: ['markError', 'setRuntimeSnapshot', 'prepareLoad'],
  },
  'error/alive/WORKING': {
    verdict: 'meaningless',
    reason:
      'markError keeps the running activity; an error ends the turn, and the read path rewrites it to IDLE.',
    writers: ['markError', 'setRuntimeSnapshot', 'prepareLoad'],
  },
  'error/unknown/IDLE': {
    verdict: 'undecided',
    reason:
      'markError during an initial launch: the launch failed, yet no writer records that no process exists.',
    writers: ['markError', 'setRuntimeSnapshot', 'prepareLoad'],
  },
} as const satisfies Partial<Record<SessionRuntimeCombination, CombinationEntry>>;

type Verdict = CombinationEntry['verdict'] | 'unlisted';

export function combinationOf(
  runtime: Pick<SessionRuntimeState, 'phase' | 'processState' | 'activity'>
): SessionRuntimeCombination {
  return `${runtime.phase}/${runtime.processState}/${runtime.activity}`;
}

function verdictOf(combination: SessionRuntimeCombination): Verdict {
  const entry: CombinationEntry | undefined = (
    SESSION_RUNTIME_COMBINATIONS as Partial<Record<SessionRuntimeCombination, CombinationEntry>>
  )[combination];
  return entry?.verdict ?? 'unlisted';
}

/** A flagged (combination, caller) pair is logged at most once per interval. */
export const FLAGGED_LOG_INTERVAL_MS = 10 * 60_000;
/** The summary is written by the first write after this long, if counts changed. */
export const SUMMARY_INTERVAL_MS = 30 * 60_000;
export const SESSION_RUNTIME_SUMMARY_MESSAGE = 'session runtime combinations';

export type SessionRuntimeCombinationCounts = {
  /** Writes that produced each combination. */
  combinations: Partial<Record<SessionRuntimeCombination, number>>;
  /** Changes of combination, keyed `from -> to`. */
  transitions: Record<string, number>;
  /** Writes that produced a meaningless, undecided or unlisted combination. */
  flagged: Array<{
    combination: SessionRuntimeCombination;
    verdict: Exclude<Verdict, 'meaningful'>;
    caller: ReportedCaller;
    count: number;
  }>;
};

type FlaggedPair = {
  combination: SessionRuntimeCombination;
  verdict: Exclude<Verdict, 'meaningful'>;
  caller: ReportedCaller;
  count: number;
  lastLoggedAt: number;
  suppressed: number;
};

type ReportLogger = Pick<ReturnType<typeof createLogger>, 'info' | 'warn'>;

/**
 * In-memory counts, bounded by the finite set of combinations, pairs and
 * callers. A write costs a few map updates; the only I/O is a rate-limited log
 * line.
 */
export class SessionRuntimeCombinationReport {
  private readonly combinations = new Map<SessionRuntimeCombination, number>();
  private readonly transitions = new Map<string, number>();
  private readonly flagged = new Map<string, FlaggedPair>();
  private changedSinceSummary = false;
  private lastSummaryAt: number;

  constructor(
    private readonly logger: ReportLogger = createLogger('session-runtime-combinations'),
    private readonly now: () => number = Date.now
  ) {
    this.lastSummaryAt = now();
  }

  record(
    sessionId: string,
    previous: SessionRuntimeState,
    next: SessionRuntimeState,
    caller: ReportedCaller
  ): void {
    const from = combinationOf(previous);
    const to = combinationOf(next);
    this.combinations.set(to, (this.combinations.get(to) ?? 0) + 1);
    if (from !== to) {
      const key = `${from} -> ${to}`;
      this.transitions.set(key, (this.transitions.get(key) ?? 0) + 1);
    }
    this.changedSinceSummary = true;

    const verdict = verdictOf(to);
    if (verdict !== 'meaningful') {
      this.flag(sessionId, from, to, verdict, caller);
    }
    if (this.now() - this.lastSummaryAt >= SUMMARY_INTERVAL_MS) {
      this.writeSummary('interval');
    }
  }

  private flag(
    sessionId: string,
    from: SessionRuntimeCombination,
    to: SessionRuntimeCombination,
    verdict: Exclude<Verdict, 'meaningful'>,
    caller: ReportedCaller
  ): void {
    const key = `${to} by ${caller}`;
    const now = this.now();
    const pair = this.flagged.get(key);
    if (pair) {
      pair.count += 1;
      if (now - pair.lastLoggedAt < FLAGGED_LOG_INTERVAL_MS) {
        pair.suppressed += 1;
        return;
      }
    }
    const current = pair ?? {
      combination: to,
      verdict,
      caller,
      count: 1,
      lastLoggedAt: now,
      suppressed: 0,
    };
    this.logger.warn('Session runtime combination flagged', {
      sessionId,
      combination: to,
      verdict,
      previous: from,
      caller,
      occurrences: current.count,
      suppressedSinceLastLog: current.suppressed,
    });
    current.lastLoggedAt = now;
    current.suppressed = 0;
    this.flagged.set(key, current);
  }

  /** Writes the summary line if anything was counted since the last one. */
  writeSummary(reason: 'interval' | 'shutdown'): void {
    this.lastSummaryAt = this.now();
    if (!this.changedSinceSummary) {
      return;
    }
    this.changedSinceSummary = false;
    this.logger.info(SESSION_RUNTIME_SUMMARY_MESSAGE, { reason, ...this.counts() });
  }

  counts(): SessionRuntimeCombinationCounts {
    return {
      combinations: Object.fromEntries(this.combinations),
      transitions: Object.fromEntries(this.transitions),
      flagged: [...this.flagged.values()].map(({ combination, verdict, caller, count }) => ({
        combination,
        verdict,
        caller,
        count,
      })),
    };
  }
}
