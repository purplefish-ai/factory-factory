import type { createLogger } from '@/backend/services/logger.service';
import { AutoIterationStatus } from '@/shared/core';
import type {
  AgentLogbookEntry,
  AutoIterationConfig,
  AutoIterationProgress,
  AutoIterationSnapshot,
  CritiqueResult,
  MetricEvaluation,
  TestCommandResult,
} from './auto-iteration.types';
import type { AutoIterationSessionBridge, AutoIterationWorkspaceBridge } from './bridges';
import { amendHead, commitAll, getHeadDiff, hasUncommittedChanges, revertHead } from './git-ops';
import { logbookService } from './logbook.service';
import {
  buildCrashFixPrompt,
  buildCritiquePrompt,
  buildHandoffPrompt,
  buildImplementPrompt,
  buildMeasurePrompt,
  buildSystemPrompt,
} from './prompts';
import { runTestCommand, truncateTestOutput } from './test-runner.service';

type Logger = ReturnType<typeof createLogger>;

interface RunningLoop {
  workspaceId: string;
  sessionId: string;
  config: AutoIterationConfig;
  progress: AutoIterationProgress;
  pauseRequested: boolean;
  stopRequested: boolean;
}

/**
 * Core auto-iteration loop orchestrator.
 * Manages the measure → implement → measure → evaluate → critique → accept/reject cycle.
 */
export class AutoIterationService {
  private loops = new Map<string, RunningLoop>();
  private sessionBridge: AutoIterationSessionBridge | null = null;
  private workspaceBridge: AutoIterationWorkspaceBridge | null = null;

  constructor(private readonly logger: Logger) {}

  /** Inject cross-service bridges at startup. */
  configure(
    sessionBridge: AutoIterationSessionBridge,
    workspaceBridge: AutoIterationWorkspaceBridge
  ): void {
    this.sessionBridge = sessionBridge;
    this.workspaceBridge = workspaceBridge;
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

  /** Start the auto-iteration loop for a workspace. */
  async start(workspaceId: string, config: AutoIterationConfig): Promise<void> {
    if (this.loops.has(workspaceId)) {
      throw new Error(`Auto-iteration already running for workspace ${workspaceId}`);
    }

    const worktreePath = await this.workspace.getWorktreePath(workspaceId);
    await this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.RUNNING);

    // Start ACP session
    const systemPrompt = buildSystemPrompt(config);
    const sessionId = await this.session.startSession(workspaceId, {
      initialPrompt: systemPrompt,
      startupModePreset: 'non_interactive',
    });
    await this.workspace.updateAutoIterationSessionId(workspaceId, sessionId);

    // Run baseline measurement
    this.logger.info('Running baseline measurement', { workspaceId });
    const baselineResult = await runTestCommand(
      worktreePath,
      config.testCommand,
      config.testTimeoutSeconds
    );
    const baselineOutput = truncateTestOutput(`${baselineResult.stdout}\n${baselineResult.stderr}`);

    // Get baseline metric evaluation from LLM
    const baselinePrompt = buildMeasurePrompt(
      baselineOutput,
      '(no previous measurement — this is the baseline)'
    );
    await this.session.sendPrompt(sessionId, baselinePrompt);
    await this.session.waitForIdle(sessionId);
    const baselineResponse = await this.session.getLastAssistantMessage(sessionId);
    const baselineEval = parseMetricEvaluation(baselineResponse);

    // Initialize logbook
    await logbookService.initialize(
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
    };

    const loop: RunningLoop = {
      workspaceId,
      sessionId,
      config,
      progress,
      pauseRequested: false,
      stopRequested: false,
    };
    this.loops.set(workspaceId, loop);
    await this.workspace.updateAutoIterationProgress(workspaceId, progress);

    // Run the loop (fire-and-forget — errors are caught internally)
    this.runLoop(loop, worktreePath).catch((err) => {
      this.logger.error('Auto-iteration loop failed', { workspaceId, error: String(err) });
      void this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.FAILED);
      this.loops.delete(workspaceId);
    });
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
    loop.pauseRequested = false;
    await this.workspace.updateAutoIterationStatus(workspaceId, AutoIterationStatus.RUNNING);

    const worktreePath = await this.workspace.getWorktreePath(workspaceId);
    this.runLoop(loop, worktreePath).catch((err) => {
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

  // --- Core loop ---

  private async runLoop(loop: RunningLoop, worktreePath: string): Promise<void> {
    const { config, progress, workspaceId } = loop;

    while (true) {
      // Check termination conditions
      if (loop.stopRequested) {
        await this.finalize(loop, AutoIterationStatus.STOPPED);
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
        const logbook = await logbookService.read(worktreePath);
        const handoffPrompt = buildHandoffPrompt(
          config,
          logbook?.iterations ?? [],
          progress.currentMetricSummary
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

      const entry = await this.runIteration(loop, worktreePath, iterationStart);

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

      await logbookService.appendEntry(worktreePath, entry);
      await this.workspace.updateAutoIterationProgress(workspaceId, progress);

      // Check if target was reached (only for accepted entries)
      if (entry.status === 'accepted') {
        const measureResult = await runTestCommand(
          worktreePath,
          config.testCommand,
          config.testTimeoutSeconds
        );
        const output = truncateTestOutput(`${measureResult.stdout}\n${measureResult.stderr}`);
        const measurePrompt = buildMeasurePrompt(output, progress.currentMetricSummary);
        await this.session.sendPrompt(loop.sessionId, measurePrompt);
        await this.session.waitForIdle(loop.sessionId);
        const measureResponse = await this.session.getLastAssistantMessage(loop.sessionId);
        const evalResult = parseMetricEvaluation(measureResponse);
        progress.currentMetricSummary = evalResult.metricSummary;

        if (evalResult.targetReached) {
          this.logger.info('Target reached!', { workspaceId, metric: evalResult.metricSummary });
          await this.workspace.updateAutoIterationProgress(workspaceId, progress);
          await this.finalize(loop, AutoIterationStatus.COMPLETED);
          return;
        }
      }
    }
  }

  private async runIteration(
    loop: RunningLoop,
    worktreePath: string,
    startedAt: string
  ): Promise<AgentLogbookEntry> {
    const { config, progress } = loop;
    const metricBefore = progress.currentMetricSummary;

    // --- IMPLEMENT PHASE ---
    const testResult = await runTestCommand(
      worktreePath,
      config.testCommand,
      config.testTimeoutSeconds
    );
    const testOutput = truncateTestOutput(`${testResult.stdout}\n${testResult.stderr}`);

    const implementPrompt = buildImplementPrompt(
      metricBefore,
      config.targetDescription,
      testOutput
    );
    await this.session.sendPrompt(loop.sessionId, implementPrompt);
    await this.session.waitForIdle(loop.sessionId);

    // Get description of what was changed
    const changeDescription = await this.session.getLastAssistantMessage(loop.sessionId);

    // Check if there are actual changes
    if (!(await hasUncommittedChanges(worktreePath))) {
      return {
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
      };
    }

    // --- MEASURE PHASE ---
    let commitSha = await commitAll(
      worktreePath,
      `auto-iteration #${progress.currentIteration}: ${changeDescription.slice(0, 72)}`
    );

    // Run test command after changes
    let postResult = await runTestCommand(
      worktreePath,
      config.testCommand,
      config.testTimeoutSeconds
    );

    // --- CRASH HANDLING ---
    if (postResult.exitCode !== 0 && !postResult.timedOut) {
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
        return crashResult.entry;
      }
      // Fix succeeded — use the fresh test result and updated SHA for evaluation
      postResult = crashResult.fixedResult;
      commitSha = crashResult.updatedCommitSha;
    }
    if (postResult.timedOut) {
      await revertHead(worktreePath);
      return {
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
      };
    }

    // --- EVALUATE PHASE ---
    const postOutput = truncateTestOutput(`${postResult.stdout}\n${postResult.stderr}`);
    const measurePrompt = buildMeasurePrompt(postOutput, metricBefore);
    await this.session.sendPrompt(loop.sessionId, measurePrompt);
    await this.session.waitForIdle(loop.sessionId);
    const measureResponse = await this.session.getLastAssistantMessage(loop.sessionId);
    const evalResult = parseMetricEvaluation(measureResponse);

    if (!evalResult.improved) {
      await revertHead(worktreePath);
      return {
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
        fixAttempts: 0,
        critiqueNotes: null,
        critiqueApproved: null,
      };
    }

    // --- CRITIQUE PHASE ---
    const diff = await getHeadDiff(worktreePath);
    const truncatedDiff = diff.length > 5000 ? `${diff.slice(0, 5000)}\n... (truncated)` : diff;
    const critiquePrompt = buildCritiquePrompt(truncatedDiff);
    await this.session.sendPrompt(loop.sessionId, critiquePrompt);
    await this.session.waitForIdle(loop.sessionId);
    const critiqueResponse = await this.session.getLastAssistantMessage(loop.sessionId);
    const critique = parseCritiqueResult(critiqueResponse);

    if (!critique.approved) {
      await revertHead(worktreePath);
      return {
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
        fixAttempts: 0,
        critiqueNotes: critique.notes,
        critiqueApproved: false,
      };
    }

    // --- ACCEPTED ---
    return {
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
      fixAttempts: 0,
      critiqueNotes: critique.notes,
      critiqueApproved: true,
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
    { entry: AgentLogbookEntry } | { fixedResult: TestCommandResult; updatedCommitSha: string }
  > {
    const maxAttempts = 2;
    let currentCommitSha = commitSha;
    let latestResult: { stdout: string; stderr: string } = initialResult;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Use the most recent failure output so the agent sees what's still broken
      const errorOutput = truncateTestOutput(`${latestResult.stdout}\n${latestResult.stderr}`, 100);
      const fixPrompt = buildCrashFixPrompt(errorOutput, attempt);
      await this.session.sendPrompt(loop.sessionId, fixPrompt);
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
      if (retryResult.exitCode === 0 && !retryResult.timedOut) {
        return { fixedResult: retryResult, updatedCommitSha: currentCommitSha };
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
        fixAttempts: maxAttempts,
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
  // Try to find JSON in the response (may be wrapped in markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found');
  }
  return JSON.parse(jsonMatch[0]);
}
