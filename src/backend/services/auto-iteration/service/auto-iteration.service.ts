import type { createLogger } from '@/backend/services/logger.service';
import { AutoIterationStatus } from '@/shared/core';
import type {
  AgentLogbookEntry,
  AutoIterationConfig,
  AutoIterationProgress,
  AutoIterationSnapshot,
  CritiqueResult,
  IterationPhase,
  MetricEvaluation,
  TestCommandResult,
} from './auto-iteration.types';
import type {
  AutoIterationLogbookBridge,
  AutoIterationSessionBridge,
  AutoIterationWorkspaceBridge,
} from './bridges';
import {
  amendHead,
  commitAll,
  discardUncommittedChanges,
  getHeadDiff,
  hasUncommittedChanges,
  revertHead,
} from './git-ops';
import { insightsService } from './insights.service';
import {
  buildCrashFixPrompt,
  buildCreatePrPrompt,
  buildCritiquePrompt,
  buildHandoffPrompt,
  buildImplementPrompt,
  buildMeasurePrompt,
  buildSystemPrompt,
} from './prompts';
import { runTestCommand, truncateTestOutput } from './test-runner.service';

type Logger = ReturnType<typeof createLogger>;

/** Default prompt timeout: 20 minutes. */
const DEFAULT_PROMPT_TIMEOUT_SECONDS = 1200;

/** Get prompt timeout in milliseconds from config, or the default. */
function getPromptTimeoutMs(config: AutoIterationConfig): number | undefined {
  const seconds = config.promptTimeoutSeconds ?? DEFAULT_PROMPT_TIMEOUT_SECONDS;
  return seconds > 0 ? seconds * 1000 : undefined;
}

interface RunningLoop {
  workspaceId: string;
  sessionId: string;
  config: AutoIterationConfig;
  progress: AutoIterationProgress;
  pauseRequested: boolean;
  stopRequested: boolean;
  /** Set when the session died unexpectedly, so the loop finalizes as FAILED, not STOPPED. */
  failedByDeath: boolean;
  /** Tracks the active loop promise to prevent concurrent loops on resume. */
  loopPromise: Promise<void> | null;
}

/**
 * Core auto-iteration loop orchestrator.
 * Manages the measure → implement → measure → evaluate → critique → accept/reject cycle.
 */
export class AutoIterationService {
  private loops = new Map<string, RunningLoop>();
  private sessionBridge: AutoIterationSessionBridge | null = null;
  private workspaceBridge: AutoIterationWorkspaceBridge | null = null;
  private logbookBridge: AutoIterationLogbookBridge | null = null;

  constructor(private readonly logger: Logger) {}

  /** Inject cross-service bridges at startup. */
  configure(
    sessionBridge: AutoIterationSessionBridge,
    workspaceBridge: AutoIterationWorkspaceBridge,
    logbookBridge: AutoIterationLogbookBridge
  ): void {
    this.sessionBridge = sessionBridge;
    this.workspaceBridge = workspaceBridge;
    this.logbookBridge = logbookBridge;
  }

  private get session(): AutoIterationSessionBridge {
    if (!this.sessionBridge) {
      throw new Error('AutoIterationService not configured');
    }
    return this.sessionBridge;
  }

  private get workspace(): AutoIterationWorkspaceBridge {
    if (!this.workspaceBridge) {
      throw new Error('AutoIterationService not configured');
    }
    return this.workspaceBridge;
  }

  private get logbook(): AutoIterationLogbookBridge {
    if (!this.logbookBridge) {
      throw new Error('AutoIterationService not configured');
    }
    return this.logbookBridge;
  }

  /** Start the auto-iteration loop for a workspace. Atomically registers the loop to prevent races. */
  async start(workspaceId: string, config: AutoIterationConfig): Promise<void> {
    // Atomic guard: register the loop synchronously before any await to prevent concurrent starts
    if (this.loops.has(workspaceId)) {
      throw new Error(`Auto-iteration already running for workspace ${workspaceId}`);
    }
    const placeholder: RunningLoop = {
      workspaceId,
      sessionId: '',
      config,
      progress: {
        currentIteration: 0,
        baselineMetricSummary: '',
        currentMetricSummary: '',
        acceptedCount: 0,
        rejectedRegressionCount: 0,
        rejectedCritiqueCount: 0,
        crashedCount: 0,
        sessionRecycleCount: 0,
        startedAt: new Date().toISOString(),
        lastIterationAt: null,
        currentPhase: 'baseline',
        lastTestOutput: null,
      },
      pauseRequested: false,
      stopRequested: false,
      failedByDeath: false,
      loopPromise: null,
    };
    this.loops.set(workspaceId, placeholder);

    try {
      const worktreePath = await this.workspace.getWorktreePath(workspaceId);
      await this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.RUNNING);

      // Initialize insights file (no-op if already exists) and load open entries
      await insightsService.initialize(worktreePath);
      const insightsContent = await insightsService.getOpenContent(worktreePath);

      // Start ACP session
      const systemPrompt = buildSystemPrompt(config, insightsContent);
      const sessionId = await this.session.startSession(workspaceId, {
        initialPrompt: systemPrompt,
        startupModePreset: 'non_interactive',
      });
      placeholder.sessionId = sessionId;
      await this.workspace.updateAutoIterationSessionId(workspaceId, sessionId);

      // Run baseline measurement
      this.logger.info('Running baseline measurement', { workspaceId });
      await this.emitPhase(placeholder, 'baseline');
      const baselineResult = await runTestCommand(
        worktreePath,
        config.testCommand,
        config.testTimeoutSeconds
      );
      const baselineOutput = truncateTestOutput(
        `${baselineResult.stdout}\n${baselineResult.stderr}`
      );
      await this.emitPhase(placeholder, 'evaluating', baselineOutput);

      // Get baseline metric evaluation from LLM
      const baselinePrompt = buildMeasurePrompt(
        baselineOutput,
        '(no previous measurement — this is the baseline)'
      );
      await this.session.sendPrompt(sessionId, baselinePrompt, getPromptTimeoutMs(config));
      await this.session.waitForIdle(sessionId);
      const baselineResponse = await this.session.getLastAssistantMessage(sessionId);
      const baselineEval = parseMetricEvaluation(baselineResponse);

      // Initialize logbook
      await this.logbook.initialize(
        worktreePath,
        workspaceId,
        config,
        baselineOutput,
        baselineEval.metricSummary
      );

      const progress: AutoIterationProgress = {
        currentIteration: 0,
        baselineMetricSummary: baselineEval.metricSummary,
        currentMetricSummary: baselineEval.metricSummary,
        acceptedCount: 0,
        rejectedRegressionCount: 0,
        rejectedCritiqueCount: 0,
        crashedCount: 0,
        sessionRecycleCount: 0,
        startedAt: new Date().toISOString(),
        lastIterationAt: null,
        currentPhase: 'idle',
        lastTestOutput: baselineOutput,
      };

      // Update the placeholder with real data
      placeholder.sessionId = sessionId;
      placeholder.progress = progress;
      await this.workspace.updateAutoIterationProgress(workspaceId, progress);

      // Run the loop (fire-and-forget — errors are caught internally)
      placeholder.loopPromise = this.runLoop(placeholder, worktreePath).catch((err) => {
        this.logger.error('Auto-iteration loop failed', { workspaceId, error: String(err) });
        void this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.FAILED);
        this.loops.delete(workspaceId);
      });
    } catch (err) {
      // Clean up the session if one was started before the failure
      if (placeholder.sessionId) {
        try {
          await this.session.stopSession(placeholder.sessionId);
        } catch {
          // Session cleanup is best-effort
        }
        void this.workspace.updateAutoIterationSessionId(workspaceId, null);
      }
      this.loops.delete(workspaceId);
      void this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.FAILED);
      throw err;
    }
  }

  /** Pause the loop between iterations. */
  pause(workspaceId: string): void {
    const loop = this.loops.get(workspaceId);
    if (loop) {
      loop.pauseRequested = true;
    }
  }

  /** Resume from paused state. */
  async resume(workspaceId: string): Promise<void> {
    const loop = this.loops.get(workspaceId);
    if (!loop) {
      throw new Error(`No auto-iteration loop found for workspace ${workspaceId}`);
    }

    // Wait for the previous loop to fully exit before starting a new one
    if (loop.loopPromise) {
      const prevPromise = loop.loopPromise;
      await prevPromise;
      // Another resume() may have already restarted the loop while we awaited
      if (loop.loopPromise !== null && loop.loopPromise !== prevPromise) {
        return; // A newer loop is already running
      }
    }

    // Re-check the map: the loop's .catch() deletes the entry on failure,
    // so the stale `loop` reference would be orphaned from the map.
    if (!this.loops.has(workspaceId)) {
      throw new Error(
        `Auto-iteration loop for workspace ${workspaceId} failed and was cleaned up — cannot resume`
      );
    }

    loop.pauseRequested = false;

    // Set a sentinel promise synchronously to prevent concurrent resume() calls from
    // both passing the swap-check guard — mirrors how start() uses a synchronous map insertion.
    // A second concurrent resume() will see loopPromise changed and bail out at the swap-check.
    const sentinel = Promise.resolve();
    loop.loopPromise = sentinel;

    await this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.RUNNING);

    const worktreePath = await this.workspace.getWorktreePath(workspaceId);
    loop.loopPromise = this.runLoop(loop, worktreePath).catch((err) => {
      this.logger.error('Auto-iteration loop failed on resume', {
        workspaceId,
        error: String(err),
      });
      void this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.FAILED);
      this.loops.delete(workspaceId);
    });
  }

  /** Stop the loop (finishes current iteration, then stops). */
  stop(workspaceId: string): void {
    const loop = this.loops.get(workspaceId);
    if (loop) {
      loop.stopRequested = true;
    }
  }

  /** Get current snapshot. */
  getStatus(workspaceId: string): AutoIterationSnapshot | null {
    const loop = this.loops.get(workspaceId);
    if (!loop) {
      return null;
    }
    return {
      status: loop.pauseRequested ? AutoIterationStatus.PAUSED : AutoIterationStatus.RUNNING,
      config: loop.config,
      progress: loop.progress,
    };
  }

  /** Check if a loop is running. */
  isRunning(workspaceId: string): boolean {
    return this.loops.has(workspaceId);
  }

  /**
   * Handle notification that an auto-iteration session has died unexpectedly.
   * Called by the orchestration layer when the ACP process exits for a session
   * belonging to an auto-iteration workspace. Idempotent — no-op if the loop
   * is already cleaned up by the promise rejection path.
   */
  onSessionDeath(workspaceId: string, sessionId: string): void {
    const loop = this.loops.get(workspaceId);
    if (!loop || loop.sessionId !== sessionId) {
      return;
    }

    this.logger.warn('Auto-iteration session died unexpectedly', { workspaceId, sessionId });
    loop.failedByDeath = true;
    loop.stopRequested = true;
    void this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.FAILED);
    void this.workspace.updateAutoIterationSessionId(workspaceId, null);
    this.loops.delete(workspaceId);
  }

  // --- Phase tracking ---

  /** Update the current phase and optionally test output, then persist to DB for UI polling. */
  private async emitPhase(
    loop: RunningLoop,
    phase: IterationPhase,
    testOutput?: string
  ): Promise<void> {
    loop.progress.currentPhase = phase;
    if (testOutput !== undefined) {
      loop.progress.lastTestOutput = testOutput;
    }
    await this.workspace.updateAutoIterationProgress(loop.workspaceId, loop.progress);
  }

  // --- Core loop ---

  private async runLoop(loop: RunningLoop, worktreePath: string): Promise<void> {
    const { config, progress, workspaceId } = loop;

    while (true) {
      // Check termination conditions
      if (loop.stopRequested) {
        await this.finalize(
          loop,
          loop.failedByDeath ? AutoIterationStatus.FAILED : AutoIterationStatus.STOPPED
        );
        return;
      }
      if (loop.pauseRequested) {
        await this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.PAUSED);
        return; // Loop exits; resume() re-enters
      }
      if (config.maxIterations > 0 && progress.currentIteration >= config.maxIterations) {
        await this.finalize(loop, AutoIterationStatus.MAX_ITERATIONS);
        return;
      }

      // Session recycling
      if (
        progress.currentIteration > 0 &&
        progress.currentIteration % config.sessionRecycleInterval === 0
      ) {
        this.logger.info('Recycling session', {
          workspaceId,
          iteration: progress.currentIteration,
        });
        await this.emitPhase(loop, 'recycling');
        const logbook = await this.logbook.read(worktreePath);
        const recycleInsights = await insightsService.getOpenContent(worktreePath);
        const handoffPrompt = buildHandoffPrompt(
          config,
          logbook?.iterations ?? [],
          progress.currentMetricSummary,
          recycleInsights
        );
        loop.sessionId = await this.session.recycleSession(workspaceId, handoffPrompt);
        await this.workspace.updateAutoIterationSessionId(workspaceId, loop.sessionId);
        progress.sessionRecycleCount++;
      }

      progress.currentIteration++;
      const iterationStart = new Date().toISOString();

      this.logger.info('Starting iteration', {
        workspaceId,
        iteration: progress.currentIteration,
      });

      let entry: AgentLogbookEntry;
      let targetReached: boolean;
      try {
        const result = await this.runIteration(loop, worktreePath, iterationStart);
        entry = result.entry;
        targetReached = result.targetReached;
      } catch (error) {
        if (error instanceof Error && error.name === 'PromptTimeoutError') {
          // Treat prompt timeout like a crash: revert any uncommitted work and continue the loop
          this.logger.warn('Prompt timed out during iteration, treating as crash', {
            workspaceId,
            iteration: progress.currentIteration,
          });
          try {
            if (loop.progress.currentPhase === 'implementing') {
              // During implement, changes are not yet committed — discard uncommitted work
              if (await hasUncommittedChanges(worktreePath)) {
                await discardUncommittedChanges(worktreePath);
              }
            } else {
              // After implement (measure/evaluate/critique/crash_fix), commitAll has already run
              // — always revert HEAD to undo the iteration's committed changes
              await revertHead(worktreePath);
            }
          } catch (revertError) {
            this.logger.error('Failed to revert after prompt timeout, aborting loop', {
              workspaceId,
              iteration: progress.currentIteration,
              error: revertError instanceof Error ? revertError.message : String(revertError),
            });
            await this.finalize(loop, AutoIterationStatus.FAILED);
            return;
          }
          entry = {
            iteration: progress.currentIteration,
            startedAt: iterationStart,
            completedAt: new Date().toISOString(),
            status: 'crashed',
            changeDescription: 'Prompt timed out',
            commitSha: '',
            commitReverted: false,
            metricBefore: progress.currentMetricSummary,
            metricAfter: null,
            testOutput: '',
            metricImproved: null,
            crashError: error.message,
            fixAttempts: 0,
            critiqueNotes: null,
            critiqueApproved: null,
          };
          targetReached = false;
        } else {
          throw error;
        }
      }

      // Update progress
      progress.lastIterationAt = new Date().toISOString();
      // Only advance the metric when the commit was kept — reverted iterations leave the code unchanged
      if (entry.metricAfter && !entry.commitReverted) {
        progress.currentMetricSummary = entry.metricAfter;
      }
      switch (entry.status) {
        case 'accepted':
          progress.acceptedCount++;
          break;
        case 'rejected_regression':
          progress.rejectedRegressionCount++;
          break;
        case 'rejected_critique':
          progress.rejectedCritiqueCount++;
          break;
        case 'crashed':
          progress.crashedCount++;
          break;
      }

      progress.currentPhase = 'idle';
      await this.logbook.appendEntry(worktreePath, entry);
      await this.workspace.updateAutoIterationProgress(workspaceId, progress);

      // Check if target was reached (already evaluated inside runIteration for accepted entries)
      if (targetReached) {
        this.logger.info('Target reached!', { workspaceId, metric: progress.currentMetricSummary });
        await this.finalize(loop, AutoIterationStatus.COMPLETED);
        return;
      }
    }
  }

  private async runIteration(
    loop: RunningLoop,
    worktreePath: string,
    startedAt: string
  ): Promise<{ entry: AgentLogbookEntry; targetReached: boolean }> {
    const { config, progress } = loop;
    const metricBefore = progress.currentMetricSummary;

    // --- IMPLEMENT PHASE ---
    await this.emitPhase(loop, 'measuring');
    const testResult = await runTestCommand(
      worktreePath,
      config.testCommand,
      config.testTimeoutSeconds
    );
    const testOutput = truncateTestOutput(`${testResult.stdout}\n${testResult.stderr}`);
    await this.emitPhase(loop, 'implementing', testOutput);

    const implementPrompt = buildImplementPrompt(
      metricBefore,
      config.targetDescription,
      testOutput
    );
    await this.session.sendPrompt(loop.sessionId, implementPrompt, getPromptTimeoutMs(config));
    await this.session.waitForIdle(loop.sessionId);

    // Get description of what was changed
    const changeDescription = await this.session.getLastAssistantMessage(loop.sessionId);

    // Check if there are actual changes
    if (!(await hasUncommittedChanges(worktreePath))) {
      return {
        entry: {
          iteration: progress.currentIteration,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'crashed',
          changeDescription: 'No changes were made',
          commitSha: '',
          commitReverted: false,
          metricBefore,
          metricAfter: null,
          testOutput: '',
          metricImproved: null,
          crashError: 'Agent made no code changes',
          fixAttempts: 0,
          critiqueNotes: null,
          critiqueApproved: null,
        },
        targetReached: false,
      };
    }

    // --- MEASURE PHASE ---
    let commitSha = await commitAll(
      worktreePath,
      `auto-iteration #${progress.currentIteration}: ${changeDescription.slice(0, 72)}`
    );

    // Run test command after changes
    await this.emitPhase(loop, 'measuring');
    let postResult = await runTestCommand(
      worktreePath,
      config.testCommand,
      config.testTimeoutSeconds
    );

    // --- CRASH HANDLING ---
    // Only treat infrastructure-level failures as crashes (exit code > 1, e.g. syntax errors,
    // test framework failing to start). Normal test failures (exit code 1) still proceed to
    // evaluation so the loop can accept iterations that improve the pass rate incrementally.
    let crashFixAttempts = 0;
    if (postResult.exitCode > 1 && !postResult.timedOut) {
      const crashResult = await this.handleCrash(
        loop,
        worktreePath,
        postResult,
        startedAt,
        metricBefore,
        changeDescription,
        commitSha
      );
      if ('entry' in crashResult) {
        return { entry: crashResult.entry, targetReached: false };
      }
      // Fix succeeded — use the fresh test result and updated SHA for evaluation
      postResult = crashResult.fixedResult;
      commitSha = crashResult.updatedCommitSha;
      crashFixAttempts = crashResult.fixAttempts;
    }
    if (postResult.timedOut) {
      await revertHead(worktreePath);
      return {
        entry: {
          iteration: progress.currentIteration,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'crashed',
          changeDescription: changeDescription.slice(0, 500),
          commitSha,
          commitReverted: true,
          metricBefore,
          metricAfter: null,
          testOutput: truncateTestOutput(`${postResult.stdout}\n${postResult.stderr}`, 100),
          metricImproved: null,
          crashError: 'Test command timed out',
          fixAttempts: 0,
          critiqueNotes: null,
          critiqueApproved: null,
        },
        targetReached: false,
      };
    }

    // --- EVALUATE PHASE ---
    const postOutput = truncateTestOutput(`${postResult.stdout}\n${postResult.stderr}`);
    await this.emitPhase(loop, 'evaluating', postOutput);
    const measurePrompt = buildMeasurePrompt(postOutput, metricBefore);
    await this.session.sendPrompt(loop.sessionId, measurePrompt, getPromptTimeoutMs(config));
    await this.session.waitForIdle(loop.sessionId);
    const measureResponse = await this.session.getLastAssistantMessage(loop.sessionId);
    const evalResult = parseMetricEvaluation(measureResponse);

    if (!evalResult.improved) {
      await revertHead(worktreePath);
      return {
        entry: {
          iteration: progress.currentIteration,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'rejected_regression',
          changeDescription: changeDescription.slice(0, 500),
          commitSha,
          commitReverted: true,
          metricBefore,
          metricAfter: evalResult.metricSummary,
          testOutput: postOutput.slice(0, 2000),
          metricImproved: false,
          crashError: null,
          fixAttempts: crashFixAttempts,
          critiqueNotes: null,
          critiqueApproved: null,
        },
        targetReached: false,
      };
    }

    // --- CRITIQUE PHASE ---
    await this.emitPhase(loop, 'critiquing');
    const diff = await getHeadDiff(worktreePath);
    const truncatedDiff = diff.length > 5000 ? `${diff.slice(0, 5000)}\n... (truncated)` : diff;
    const critiquePrompt = buildCritiquePrompt(truncatedDiff);
    await this.session.sendPrompt(loop.sessionId, critiquePrompt, getPromptTimeoutMs(config));
    await this.session.waitForIdle(loop.sessionId);
    const critiqueResponse = await this.session.getLastAssistantMessage(loop.sessionId);
    const critique = parseCritiqueResult(critiqueResponse);

    if (!critique.approved) {
      await revertHead(worktreePath);
      return {
        entry: {
          iteration: progress.currentIteration,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'rejected_critique',
          changeDescription: changeDescription.slice(0, 500),
          commitSha,
          commitReverted: true,
          metricBefore,
          metricAfter: evalResult.metricSummary,
          testOutput: postOutput.slice(0, 2000),
          metricImproved: true,
          crashError: null,
          fixAttempts: crashFixAttempts,
          critiqueNotes: critique.notes,
          critiqueApproved: false,
        },
        targetReached: false,
      };
    }

    // --- ACCEPTED ---
    return {
      entry: {
        iteration: progress.currentIteration,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'accepted',
        changeDescription: changeDescription.slice(0, 500),
        commitSha,
        commitReverted: false,
        metricBefore,
        metricAfter: evalResult.metricSummary,
        testOutput: postOutput.slice(0, 2000),
        metricImproved: true,
        crashError: null,
        fixAttempts: crashFixAttempts,
        critiqueNotes: critique.notes,
        critiqueApproved: true,
      },
      targetReached: evalResult.targetReached,
    };
  }

  private async handleCrash(
    loop: RunningLoop,
    worktreePath: string,
    initialResult: { stdout: string; stderr: string; exitCode: number },
    startedAt: string,
    metricBefore: string,
    changeDescription: string,
    commitSha: string
  ): Promise<
    | { entry: AgentLogbookEntry }
    | { fixedResult: TestCommandResult; updatedCommitSha: string; fixAttempts: number }
  > {
    const maxAttempts = 2;
    let currentCommitSha = commitSha;
    let latestResult: { stdout: string; stderr: string } = initialResult;

    let attemptsMade = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptsMade = attempt;
      // Use the most recent failure output so the agent sees what's still broken
      const errorOutput = truncateTestOutput(`${latestResult.stdout}\n${latestResult.stderr}`, 100);
      const fixPrompt = buildCrashFixPrompt(errorOutput, attempt);
      await this.session.sendPrompt(loop.sessionId, fixPrompt, getPromptTimeoutMs(loop.config));
      await this.session.waitForIdle(loop.sessionId);

      const fixResponse = await this.session.getLastAssistantMessage(loop.sessionId);
      if (fixResponse.includes('UNFIXABLE')) {
        break;
      }

      // Amend the original commit with fixes (keeps a single commit to revert if needed)
      if (await hasUncommittedChanges(worktreePath)) {
        currentCommitSha = await amendHead(worktreePath);
      }

      // Re-run test
      const retryResult = await runTestCommand(
        worktreePath,
        loop.config.testCommand,
        loop.config.testTimeoutSeconds
      );
      if (retryResult.exitCode <= 1 && !retryResult.timedOut) {
        return {
          fixedResult: retryResult,
          updatedCommitSha: currentCommitSha,
          fixAttempts: attemptsMade,
        };
      }
      latestResult = retryResult;
    }

    // Give up — revert
    await revertHead(worktreePath);
    return {
      entry: {
        iteration: loop.progress.currentIteration,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'crashed',
        changeDescription: changeDescription.slice(0, 500),
        commitSha: currentCommitSha,
        commitReverted: true,
        metricBefore,
        metricAfter: null,
        testOutput: truncateTestOutput(`${latestResult.stdout}\n${latestResult.stderr}`, 100),
        metricImproved: null,
        crashError: latestResult.stderr.slice(-500),
        fixAttempts: attemptsMade,
        critiqueNotes: null,
        critiqueApproved: null,
      },
    };
  }

  private async finalize(loop: RunningLoop, status: AutoIterationStatus): Promise<void> {
    this.logger.info('Finalizing auto-iteration', {
      workspaceId: loop.workspaceId,
      status,
      iterations: loop.progress.currentIteration,
    });

    // If there were accepted changes, instruct the agent to open a PR before stopping.
    if (loop.progress.acceptedCount > 0) {
      try {
        const prPrompt = buildCreatePrPrompt(loop.config, loop.progress, status);
        await this.session.sendPrompt(loop.sessionId, prPrompt, getPromptTimeoutMs(loop.config));
        await this.session.waitForIdle(loop.sessionId);
      } catch (err) {
        this.logger.warn('Failed to send PR creation prompt', {
          workspaceId: loop.workspaceId,
          err,
        });
      }
    }

    try {
      await this.session.stopSession(loop.sessionId);
    } catch {
      // Session may already be stopped
    }
    await this.workspace.updateAutoIterationStatus(loop.workspaceId, status);
    await this.workspace.updateAutoIterationSessionId(loop.workspaceId, null);
    this.loops.delete(loop.workspaceId);
  }
}

// --- JSON parsing helpers ---

function parseMetricEvaluation(response: string): MetricEvaluation {
  try {
    const json = extractJson(response);
    return {
      metricSummary: String(json.metricSummary ?? 'Unknown'),
      improved: Boolean(json.improved),
      targetReached: Boolean(json.targetReached),
    };
  } catch {
    return {
      metricSummary: response.slice(0, 200),
      improved: false,
      targetReached: false,
    };
  }
}

function parseCritiqueResult(response: string): CritiqueResult {
  try {
    const json = extractJson(response);
    return {
      approved: Boolean(json.approved),
      notes: String(json.notes ?? ''),
    };
  } catch {
    // If we can't parse, reject — silently accepting unreviewed changes is riskier than blocking
    return {
      approved: false,
      notes: `Could not parse critique response: ${response.slice(0, 200)}`,
    };
  }
}

function extractJson(text: string): Record<string, unknown> {
  // Find the first balanced JSON object in the response (may be wrapped in markdown code blocks).
  // Uses brace counting instead of greedy regex to avoid matching from first `{` to last `}`.
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON found');
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error('No JSON found');
}
