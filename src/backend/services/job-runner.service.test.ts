import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./logger.service', () => ({
  createLogger: () => mockLogger,
}));

import { jobRunner } from './job-runner.service';

/**
 * A run whose completion the test controls, so pacing can be observed
 * separately from the work's duration.
 */
function controllableRun() {
  let starts = 0;
  let release: (() => void) | null = null;

  return {
    get starts() {
      return starts;
    },
    run: () => {
      starts += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    finish() {
      const resolve = release;
      release = null;
      resolve?.();
    },
  };
}

describe('jobRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    jobRunner.reset();
  });

  afterEach(async () => {
    await jobRunner.stopAll();
    jobRunner.reset();
    vi.useRealTimers();
  });

  describe('registration', () => {
    it('does not start a job just because it was registered', async () => {
      // Services declare their job at construction; nothing should be polling
      // until the server explicitly starts it.
      const run = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'first', intervalMs: 1000, run });
      jobRunner.register({ name: 'second', intervalMs: 1000, run });

      expect(jobRunner.isRunning('first')).toBe(false);
      expect(jobRunner.isRunning('second')).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).not.toHaveBeenCalled();
    });

    it('replaces the definition when the job is idle', async () => {
      // Services declare their job when constructed, and the test harness
      // builds the application graph more than once per process.
      const first = vi.fn().mockResolvedValue(undefined);
      const second = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'dup', intervalMs: 1000, run: first });
      jobRunner.register({ name: 'dup', intervalMs: 1000, run: second });

      jobRunner.start('dup');
      await vi.advanceTimersByTimeAsync(1000);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('refuses to redefine a job that is already running', () => {
      // The loop in flight would keep the old definition, so the new one would
      // silently never take effect.
      const run = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'live', intervalMs: 1000, run });
      jobRunner.start('live');

      expect(() => jobRunner.register({ name: 'live', intervalMs: 1000, run })).toThrow(
        'Job already running, cannot redefine: live'
      );
    });

    it('names the job when addressed by a name nothing registered', async () => {
      // Job names are strings, so a typo at a call site would otherwise be a
      // silent no-op.
      expect(() => jobRunner.start('typo')).toThrow('Job not registered: typo');
      expect(() => jobRunner.isRunning('typo')).toThrow('Job not registered: typo');
      expect(() => jobRunner.waitForCurrentRun('typo')).toThrow('Job not registered: typo');
      await expect(jobRunner.stop('typo')).rejects.toThrow('Job not registered: typo');
    });
  });

  describe('pacing', () => {
    it('waits out the first delay before the first run by default', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'delayed', intervalMs: 1000, run });
      jobRunner.start('delayed');

      await vi.advanceTimersByTimeAsync(999);
      expect(run).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('runs at once when the job asks to, then falls into the interval', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'eager', intervalMs: 1000, run, runImmediately: true });
      jobRunner.start('eager');

      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('measures the delay from the end of a run, not its start', async () => {
      const job = controllableRun();
      jobRunner.register({ name: 'slow', intervalMs: 1000, run: job.run });
      jobRunner.start('slow');

      await vi.advanceTimersByTimeAsync(1000);
      expect(job.starts).toBe(1);

      // The run is still in flight well past the interval. Nothing else starts:
      // overlap is impossible by construction, so there is no guard to get
      // wrong.
      await vi.advanceTimersByTimeAsync(5000);
      expect(job.starts).toBe(1);

      job.finish();
      await vi.advanceTimersByTimeAsync(999);
      expect(job.starts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(job.starts).toBe(2);

      job.finish();
    });

    it('lets the job stretch its own delay', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      const computeDelay = vi.fn((base: number) => base * 3);
      jobRunner.register({ name: 'backed-off', intervalMs: 1000, run, computeDelay });
      jobRunner.start('backed-off');

      await vi.advanceTimersByTimeAsync(2999);
      expect(run).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);
      expect(computeDelay).toHaveBeenCalledWith(1000);
    });

    it('re-reads the computed delay every cycle, so backoff can change', async () => {
      // The ratchet raises and drops its multiplier as it runs; a delay sampled
      // once at registration would freeze the backoff at whatever it was then.
      // The delay for the next cycle is computed when the current run ends, so
      // a change made *during* a run is what the following sleep must pick up.
      let multiplier = 1;
      const run = vi.fn(() => {
        multiplier = 4;
        return Promise.resolve();
      });
      jobRunner.register({
        name: 'variable',
        intervalMs: 1000,
        run,
        computeDelay: (base) => base * multiplier,
      });
      jobRunner.start('variable');

      await vi.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3999);
      expect(run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure handling', () => {
    it('logs a rejected run and keeps the loop alive', async () => {
      const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
      jobRunner.register({ name: 'flaky', intervalMs: 1000, run });
      jobRunner.start('flaky');

      await vi.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Job run failed: flaky',
        expect.objectContaining({ message: 'boom' })
      );

      // A single bad cycle must not be terminal -- these loops are the only
      // thing polling GitHub and reconciling worktrees.
      await vi.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(2);
    });
  });

  describe('waitForCurrentRun', () => {
    it('resolves immediately when the job is between runs', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'idle', intervalMs: 1000, run });
      jobRunner.start('idle');

      let resolved = false;
      void jobRunner.waitForCurrentRun('idle').then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(resolved).toBe(true);
      expect(run).not.toHaveBeenCalled();
    });

    it('resolves when the run in flight finishes, and does not wait for the next one', async () => {
      const job = controllableRun();
      jobRunner.register({
        name: 'inflight',
        intervalMs: 1000,
        run: job.run,
        runImmediately: true,
      });
      jobRunner.start('inflight');
      await vi.advanceTimersByTimeAsync(0);

      let resolved = false;
      void jobRunner.waitForCurrentRun('inflight').then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      job.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);
      // Still only the first run: the caller got the work already underway.
      expect(job.starts).toBe(1);
    });

    it('resolves immediately for a job that was never started', async () => {
      jobRunner.register({ name: 'unstarted', intervalMs: 1000, run: vi.fn() });

      await expect(jobRunner.waitForCurrentRun('unstarted')).resolves.toBeUndefined();
    });
  });

  describe('stop', () => {
    it('cancels a pending delay instead of waiting it out', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'sleeping', intervalMs: 120_000, run });
      jobRunner.start('sleeping');

      // No timer advance: shutdown must not block for the poll interval, which
      // is what the two hand-rolled cancellable sleeps existed to avoid.
      await jobRunner.stop('sleeping');

      expect(run).not.toHaveBeenCalled();
      expect(jobRunner.isRunning('sleeping')).toBe(false);
    });

    it('waits for a run that is in flight', async () => {
      const job = controllableRun();
      jobRunner.register({ name: 'busy', intervalMs: 1000, run: job.run, runImmediately: true });
      jobRunner.start('busy');
      await vi.advanceTimersByTimeAsync(0);

      let stopped = false;
      const stopping = jobRunner.stop('busy').then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);

      job.finish();
      await stopping;
      expect(stopped).toBe(true);
      expect(job.starts).toBe(1);
    });

    it('does not start another cycle after the in-flight run completes', async () => {
      const job = controllableRun();
      jobRunner.register({
        name: 'last-cycle',
        intervalMs: 1000,
        run: job.run,
        runImmediately: true,
      });
      jobRunner.start('last-cycle');
      await vi.advanceTimersByTimeAsync(0);

      const stopping = jobRunner.stop('last-cycle');
      job.finish();
      await stopping;

      await vi.advanceTimersByTimeAsync(10_000);
      expect(job.starts).toBe(1);
    });

    it('is safe to call on a job that is not running', async () => {
      jobRunner.register({ name: 'never-started', intervalMs: 1000, run: vi.fn() });

      await expect(jobRunner.stop('never-started')).resolves.toBeUndefined();
    });

    it('allows a stopped job to be started again', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'restartable', intervalMs: 1000, run });

      jobRunner.start('restartable');
      await jobRunner.stop('restartable');
      jobRunner.start('restartable');

      await vi.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(jobRunner.isRunning('restartable')).toBe(true);
    });
  });

  describe('abort signal', () => {
    it('aborts the in-flight run when the job is stopped', async () => {
      // The loops this replaced checked a shutdown flag at intermediate points
      // so a stop partway through a batch would not walk every workspace
      // first. The signal is how that check survives.
      let observed: AbortSignal | undefined;
      const job = controllableRun();
      jobRunner.register({
        name: 'abortable',
        intervalMs: 1000,
        runImmediately: true,
        run: (signal) => {
          observed = signal;
          return job.run();
        },
      });
      jobRunner.start('abortable');
      await vi.advanceTimersByTimeAsync(0);

      expect(observed?.aborted).toBe(false);

      const stopping = jobRunner.stop('abortable');
      expect(observed?.aborted).toBe(true);

      job.finish();
      await stopping;
    });

    it('hands a restarted job a signal that is not already aborted', async () => {
      const signals: AbortSignal[] = [];
      jobRunner.register({
        name: 'restarted',
        intervalMs: 1000,
        runImmediately: true,
        run: (signal) => {
          signals.push(signal);
          return Promise.resolve();
        },
      });

      jobRunner.start('restarted');
      await vi.advanceTimersByTimeAsync(0);
      await jobRunner.stop('restarted');
      expect(signals[0]?.aborted).toBe(true);

      jobRunner.start('restarted');
      await vi.advanceTimersByTimeAsync(0);
      expect(signals).toHaveLength(2);
      expect(signals[1]?.aborted).toBe(false);
    });
  });

  describe('start', () => {
    it('is idempotent, so a second call does not create a second loop', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'once', intervalMs: 1000, run });

      jobRunner.start('once');
      jobRunner.start('once');

      await vi.advanceTimersByTimeAsync(1000);
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe('restart safety', () => {
    it('refuses to build a second loop while a stop is still waiting on a run', async () => {
      // Freeing the slot before awaiting would let this `start()` through, and
      // one job would be running two loops -- the exact thing sequential
      // pacing exists to make impossible.
      const job = controllableRun();
      jobRunner.register({
        name: 'winding-down',
        intervalMs: 1000,
        runImmediately: true,
        run: job.run,
      });
      jobRunner.start('winding-down');
      await vi.advanceTimersByTimeAsync(0);
      expect(job.starts).toBe(1);

      const stopping = jobRunner.stop('winding-down');
      jobRunner.start('winding-down');
      await vi.advanceTimersByTimeAsync(0);

      // No second loop alongside the one winding down.
      expect(job.starts).toBe(1);

      job.finish();
      await stopping;

      // The start is not dropped either: stop-then-start means started, so the
      // job comes back once the old loop has settled -- with exactly one loop,
      // which the interval below would expose as double-counting if not.
      expect(jobRunner.isRunning('winding-down')).toBe(true);
      expect(job.starts).toBe(2);

      job.finish();
      await vi.advanceTimersByTimeAsync(1000);
      expect(job.starts).toBe(3);
      job.finish();
    });

    it('drops a pending restart when a second stop supersedes it', async () => {
      const run = vi.fn().mockResolvedValue(undefined);
      const job = controllableRun();
      jobRunner.register({
        name: 'superseded',
        intervalMs: 1000,
        runImmediately: true,
        run: () => {
          run();
          return job.run();
        },
      });
      jobRunner.start('superseded');
      await vi.advanceTimersByTimeAsync(0);

      const first = jobRunner.stop('superseded');
      jobRunner.start('superseded');
      const second = jobRunner.stop('superseded');

      job.finish();
      await Promise.all([first, second]);

      expect(jobRunner.isRunning('superseded')).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('waits for a first run that stops the job from inside itself', async () => {
      // Inside the `starting` window the slot is not filled yet, so `stop()`
      // would have had nothing to await and could resolve while the run was
      // still going -- against the documented guarantee.
      let stopPromise: Promise<void> | null = null;
      let finished = false;
      jobRunner.register({
        name: 'self-stopping',
        intervalMs: 1000,
        runImmediately: true,
        run: async () => {
          stopPromise = jobRunner.stop('self-stopping');
          await Promise.resolve();
          finished = true;
        },
      });

      jobRunner.start('self-stopping');
      await vi.advanceTimersByTimeAsync(0);

      expect(stopPromise).not.toBeNull();
      await stopPromise;
      expect(finished).toBe(true);
    });

    it('makes a second stop wait for the same run as the first', async () => {
      const job = controllableRun();
      jobRunner.register({ name: 'twice', intervalMs: 1000, runImmediately: true, run: job.run });
      jobRunner.start('twice');
      await vi.advanceTimersByTimeAsync(0);

      let secondResolved = false;
      const first = jobRunner.stop('twice');
      const second = jobRunner.stop('twice').then(() => {
        secondResolved = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(secondResolved).toBe(false);

      job.finish();
      await Promise.all([first, second]);
      expect(secondResolved).toBe(true);
    });

    it('frees the slot when the loop dies outside a run, so the job can restart', async () => {
      // `computeDelay` runs outside `runOnce`, so a throw there escapes the
      // per-run catch and kills the loop. If the dead promise stayed parked in
      // the slot, `start()` would refuse to run this job for the rest of the
      // process.
      let explode = true;
      const run = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({
        name: 'exploding',
        intervalMs: 1000,
        runImmediately: true,
        run,
        computeDelay: (base) => {
          if (explode) {
            throw new Error('backoff blew up');
          }
          return base;
        },
      });

      jobRunner.start('exploding');
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Job loop terminated unexpectedly: exploding',
        expect.objectContaining({ message: 'backoff blew up' })
      );
      expect(jobRunner.isRunning('exploding')).toBe(false);

      explode = false;
      jobRunner.start('exploding');
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('has the first run observable the moment start() returns', async () => {
      // `waitForCurrentRun` is how the /snapshots handler holds the first
      // snapshot_full until the store is seeded. Deferring the first run by
      // even one microtask would let a caller in the same tick see no run in
      // flight and read an empty store.
      const job = controllableRun();
      jobRunner.register({
        name: 'sync-first',
        intervalMs: 1000,
        runImmediately: true,
        run: job.run,
      });

      jobRunner.start('sync-first');

      expect(job.starts).toBe(1);
      let resolved = false;
      void jobRunner.waitForCurrentRun('sync-first').then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      job.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);
    });

    it('holds the idempotence guard even when the first run re-enters start()', async () => {
      // A `runImmediately` job used to execute its first run synchronously
      // inside `start()`, before the slot was filled, so a re-entrant call saw
      // an unstarted job.
      const run = vi.fn(() => {
        jobRunner.start('reentrant');
        return Promise.resolve();
      });
      jobRunner.register({ name: 'reentrant', intervalMs: 1000, runImmediately: true, run });

      jobRunner.start('reentrant');
      await vi.advanceTimersByTimeAsync(0);

      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe('startAll / stopAll', () => {
    it('starts every registered job', async () => {
      const first = vi.fn().mockResolvedValue(undefined);
      const second = vi.fn().mockResolvedValue(undefined);
      jobRunner.register({ name: 'a', intervalMs: 1000, run: first });
      jobRunner.register({ name: 'b', intervalMs: 2000, run: second });

      jobRunner.startAll();
      await vi.advanceTimersByTimeAsync(2000);

      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('stops jobs concurrently, so shutdown costs the slowest run and not their sum', async () => {
      const slow = controllableRun();
      const alsoSlow = controllableRun();
      jobRunner.register({ name: 'x', intervalMs: 1000, run: slow.run, runImmediately: true });
      jobRunner.register({ name: 'y', intervalMs: 1000, run: alsoSlow.run, runImmediately: true });
      jobRunner.startAll();
      await vi.advanceTimersByTimeAsync(0);

      let stopped = false;
      const stopping = jobRunner.stopAll().then(() => {
        stopped = true;
      });

      // Both were asked to stop before either finished; sequential shutdown
      // would still be waiting on the first.
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);

      slow.finish();
      alsoSlow.finish();
      await stopping;

      expect(stopped).toBe(true);
      expect(jobRunner.isRunning('x')).toBe(false);
      expect(jobRunner.isRunning('y')).toBe(false);
    });
  });
});
