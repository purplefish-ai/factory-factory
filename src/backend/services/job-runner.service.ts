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
  /**
   * The work. Rejections are logged and the loop continues.
   *
   * The signal aborts when the job is asked to stop, so a run partway through
   * a long batch can give up instead of finishing it. Every loop this replaced
   * checked a shutdown flag at intermediate points for exactly that reason --
   * without it, stopping the PR poll would still walk every workspace.
   */
  run: (signal: AbortSignal) => Promise<unknown>;
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
  /**
   * Set for the window inside `start()` where the loop is executing its first
   * run but `loop` has not been assigned yet. Without it the idempotence guard
   * is blind during exactly that window.
   */
  starting: boolean;
  stopping: boolean;
  /**
   * A `start()` that arrived while a stop was winding down. Honoured once the
   * old loop settles, so "stop then start" ends up started instead of leaving
   * the caller believing the job runs when nothing does.
   */
  restartRequested: boolean;
  /** The stop in progress, so concurrent stops share one wait. */
  stopPending: Promise<void> | null;
  /** Aborted by `stop()`, handed to the run so it can bail out mid-batch. */
  abortController: AbortController;
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
    const existing = this.jobs.get(definition.name);
    // `starting` counts as running: during that window the first run is already
    // executing under the old definition, so replacing the entry would leave
    // that loop live while a later `start()` builds a second one for the new
    // definition under the same name.
    if (existing?.loop != null || existing?.starting) {
      throw new Error(`Job already running, cannot redefine: ${definition.name}`);
    }
    this.jobs.set(definition.name, {
      definition,
      loop: null,
      starting: false,
      stopping: false,
      restartRequested: false,
      stopPending: null,
      abortController: new AbortController(),
      currentRun: null,
      cancelSleep: null,
    });
  }

  isRunning(name: string): boolean {
    return this.get(name).loop !== null;
  }

  start(name: string): void {
    const state = this.get(name);
    if (state.stopPending !== null) {
      // A stop is still winding down. Starting here would be refused for as
      // long as the old loop lives and then never retried, leaving the caller
      // believing the job runs while nothing polls. Record the intent instead;
      // `stop()` honours it once the old loop has settled.
      state.restartRequested = true;
      return;
    }
    if (state.loop !== null || state.starting) {
      return; // Already running
    }
    // `stop()` leaves this set so a loop still between its run and its `while`
    // check cannot carry on; clearing it is the last thing that happens before
    // a new loop exists, and the only place it happens.
    state.stopping = false;
    // Fresh controller per start: a job stopped and started again must not
    // hand its runs a signal that is already aborted.
    state.abortController = new AbortController();

    // A `runImmediately` job executes its first run synchronously inside this
    // call, before `state.loop` can be assigned. That is deliberate -- callers
    // of `waitForCurrentRun` rely on the first run being observable the moment
    // `start()` returns -- but it leaves the guard above blind, so a run that
    // re-entered `start()` would get a second loop. `starting` covers exactly
    // that window.
    state.starting = true;
    try {
      const loop = this.runLoop(state)
        // A loop that dies must not take the process with it, and must not
        // leave `stop()` awaiting a rejected promise.
        .catch((error) => {
          logger.error(`Job loop terminated unexpectedly: ${name}`, toError(error));
        })
        .finally(() => {
          // Free the slot however the loop ended. Without this, a throw from
          // outside `runOnce` -- `computeDelay`, say -- leaves a settled
          // promise parked here and `start()` refuses the job ever again.
          if (state.loop === loop) {
            state.loop = null;
          }
        });
      state.loop = loop;
    } finally {
      state.starting = false;
    }

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
   *
   * The slot stays occupied until the loop has actually settled. Clearing it
   * up front would let a `start()` arriving during the wait build a second
   * loop alongside the one still winding down -- two loops for one job, which
   * is the single thing sequential pacing is supposed to make impossible --
   * and would let a second `stop()` resolve while the first run is still going.
   */
  async stop(name: string): Promise<void> {
    const state = this.get(name);
    // An explicit stop supersedes a restart that was requested before it.
    state.restartRequested = false;

    if (state.stopPending !== null) {
      await state.stopPending; // A stop is already under way; share its wait.
      return;
    }

    state.stopping = true;
    state.abortController.abort();
    state.cancelSleep?.();

    // Everything above is synchronous, so a stop arriving after this point
    // finds `stopPending` set and joins rather than starting a second teardown.
    const pending = (async () => {
      const { loop, currentRun } = state;
      if (loop !== null) {
        await loop;
      } else if (currentRun !== null) {
        // Inside the `starting` window the slot is not filled yet, but a run
        // is already executing -- reachable when a job's own first run stops
        // it.
        await currentRun;
      }
    })();
    state.stopPending = pending;

    try {
      await pending;
    } finally {
      state.stopPending = null;
    }

    // `stopping` deliberately stays set: a loop may still be between its
    // `runOnce` and its `while` check, and clearing the flag here would let it
    // carry on as though nothing had happened. `start()` is what clears it.
    logger.info('Job stopped', { job: name });

    if (state.restartRequested) {
      state.restartRequested = false;
      this.start(name);
    }
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
    const { signal } = state.abortController;

    // Published *before* the callback is invoked. Building the promise from
    // the call would leave `currentRun` unset for the callback's synchronous
    // prefix, and a job that stops itself from there would find nothing to
    // wait on -- the stop would be lost rather than merely un-awaited.
    let settle!: () => void;
    const run = new Promise<void>((resolve) => {
      settle = resolve;
    });
    state.currentRun = run;

    try {
      await state.definition.run(signal);
    } catch (error) {
      logger.error(`Job run failed: ${state.definition.name}`, toError(error));
    } finally {
      // Identity-checked: only clear the slot if it still holds *this* run, so
      // a late settle cannot erase a newer run's promise.
      if (state.currentRun === run) {
        state.currentRun = null;
      }
      settle();
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
