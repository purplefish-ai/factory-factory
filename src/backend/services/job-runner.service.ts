/**
 * Job Runner
 *
 * One place where the backend's recurring background work is declared and its
 * lifecycle is owned. Before this existed, each poll loop hand-rolled the same
 * machinery -- a shutdown flag, an in-flight promise, a guard against
 * overlapping ticks, and (in two cases) a cancellable sleep -- and the five
 * copies had drifted apart in their details.
 *
 * Jobs are paced *sequentially*: the delay is measured from the end of one run
 * to the start of the next. That is what the ratchet and periodic-task loops
 * already did, and adopting it for the three `setInterval` loops is what lets
 * the overlap guards go away -- a job cannot start again while it is still
 * running, structurally, so there is nothing to guard. The cost is that a run
 * taking `d` ms pushes the next start to `interval + d` rather than landing on
 * a wall-clock boundary; every interval here is minutes and every run is
 * seconds, so the drift is not observable.
 *
 * Deliberately absent: a public "run this job now" API. The two loops that had
 * a cancellable sleep only ever cancelled it from their own `stop()`, so
 * interruptibility is a shutdown concern, not a scheduling feature.
 */

import { toError } from '@/backend/lib/error-utils';
import { createLogger } from './logger.service';

const logger = createLogger('job-runner');

export interface JobDefinition {
  /** Stable identifier. Used in logs and to address the job after registration. */
  name: string;
  /** Base delay between the end of one run and the start of the next. */
  intervalMs: number;
  /** The work. Rejections are logged and the loop continues. */
  run: () => Promise<unknown>;
  /**
   * Run once at `start()` instead of waiting out the first delay. Matches what
   * the ratchet, periodic-task and snapshot-reconciliation loops did; the PR
   * sync and reconciliation cleanup loops waited, and still do.
   */
  runImmediately?: boolean;
  /**
   * Adjust the delay after each run. Exists for the ratchet, which stretches
   * its interval while GitHub is rate-limiting it.
   */
  computeDelay?: (baseMs: number) => number;
}

interface JobState {
  definition: JobDefinition;
  /** The running loop, or null when the job is stopped. */
  loop: Promise<void> | null;
  stopping: boolean;
  /** The run currently executing, exposed through `waitForCurrentRun`. */
  currentRun: Promise<void> | null;
  /** Settles the pending sleep early. Null when the job is not sleeping. */
  cancelSleep: (() => void) | null;
}

export class JobRunner {
  private readonly jobs = new Map<string, JobState>();

  /**
   * Declare a job. Does not start it.
   *
   * Re-registering an idle job replaces its definition, because services
   * declare their job when they are constructed and a process may construct
   * the application graph more than once (the test harness does). Re-declaring
   * a job that is *running* is a wiring mistake -- the loop already in flight
   * would keep the old definition -- so it throws.
   */
  register(definition: JobDefinition): void {
    if (this.jobs.get(definition.name)?.loop != null) {
      throw new Error(`Job already running, cannot redefine: ${definition.name}`);
    }
    this.jobs.set(definition.name, {
      definition,
      loop: null,
      stopping: false,
      currentRun: null,
      cancelSleep: null,
    });
  }

  /** Registered job names, in registration order. */
  registeredJobs(): string[] {
    return [...this.jobs.keys()];
  }

  isRunning(name: string): boolean {
    return this.get(name).loop !== null;
  }

  start(name: string): void {
    const state = this.get(name);
    if (state.loop !== null) {
      return; // Already running
    }
    state.stopping = false;
    // A loop that dies must not take the process with it, and must not leave
    // `stop()` awaiting a rejected promise.
    state.loop = this.runLoop(state).catch((error) => {
      logger.error(`Job loop terminated unexpectedly: ${name}`, toError(error));
    });
    logger.info('Job started', { job: name, intervalMs: state.definition.intervalMs });
  }

  startAll(): void {
    for (const name of this.jobs.keys()) {
      this.start(name);
    }
  }

  /**
   * Resolve once the run that is executing right now has finished, or
   * immediately if the job is between runs.
   *
   * This does not wait for a *next* run: a caller that needs the job's output
   * wants the work already underway, not another cycle of it. The /snapshots
   * WebSocket handler uses it to hold the first `snapshot_full` until the
   * startup reconciliation has populated the store.
   */
  waitForCurrentRun(name: string): Promise<void> {
    return this.get(name).currentRun ?? Promise.resolve();
  }

  /**
   * Stop a job, cancelling a pending delay and awaiting any run in flight.
   *
   * The wait for an in-flight run is unbounded, which is exactly what the five
   * loops did before this runner existed (`await this.syncInProgress` and its
   * equivalents). It is a real hazard -- a wedged `gh` call inside a run would
   * hold up process exit -- but bounding it here would silently change shutdown
   * to abandon work mid-flight, which is a behaviour decision and not part of
   * consolidating the loops.
   */
  async stop(name: string): Promise<void> {
    const state = this.get(name);
    state.stopping = true;
    state.cancelSleep?.();

    if (state.loop !== null) {
      const { loop } = state;
      state.loop = null;
      await loop;
    }
    logger.info('Job stopped', { job: name });
  }

  /**
   * Stop every job concurrently.
   *
   * Concurrently rather than in a declared order because these loops are
   * independent of one another -- what matters is that they have all stopped
   * before the caller tears down the database and the network. Stopping them
   * in sequence would make shutdown as slow as the *sum* of the in-flight
   * runs instead of the slowest one.
   */
  async stopAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((name) => this.stop(name)));
  }

  /** Test seam: drop all registrations. Not used in production code. */
  reset(): void {
    this.jobs.clear();
  }

  private get(name: string): JobState {
    const state = this.jobs.get(name);
    if (!state) {
      throw new Error(`Job not registered: ${name}`);
    }
    return state;
  }

  private async runLoop(state: JobState): Promise<void> {
    if (!state.definition.runImmediately) {
      await this.sleep(state);
    }

    while (!state.stopping) {
      await this.runOnce(state);
      if (state.stopping) {
        break;
      }
      await this.sleep(state);
    }
  }

  private async runOnce(state: JobState): Promise<void> {
    const run = (async () => {
      try {
        await state.definition.run();
      } catch (error) {
        logger.error(`Job run failed: ${state.definition.name}`, toError(error));
      }
    })();

    state.currentRun = run;
    try {
      await run;
    } finally {
      // Identity-checked: only clear the slot if it still holds *this* run, so
      // a late settle cannot erase a newer run's promise.
      if (state.currentRun === run) {
        state.currentRun = null;
      }
    }
  }

  private sleep(state: JobState): Promise<void> {
    if (state.stopping) {
      return Promise.resolve();
    }

    const { intervalMs, computeDelay } = state.definition;
    const delayMs = computeDelay ? computeDelay(intervalMs) : intervalMs;

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (state.cancelSleep === finish) {
          state.cancelSleep = null;
        }
        resolve();
      };

      state.cancelSleep = finish;
      timer = setTimeout(finish, delayMs);
    });
  }
}

export const jobRunner = new JobRunner();
