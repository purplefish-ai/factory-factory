import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import { workspaceDataService } from '@/backend/services/workspace';
import { FactoryConfigService } from './factory-config.service';
import { PortAllocationService } from './port-allocation.service';
import {
  type RunScriptCommandCache,
  runScriptConfigPersistenceService,
} from './run-script-config-persistence.service';
import { RunScriptExecution } from './run-script-execution';
import { RunScriptOutputBuffer } from './run-script-output-buffer';
import {
  runCleanupScriptProcess,
  shouldRejectStopWithoutProcess,
} from './run-script-process-utils';
import { runScriptProxyService } from './run-script-proxy.service';
import { runScriptStateMachine } from './run-script-state-machine.service';

const logger = createLogger('run-script-service');
const MAX_OUTPUT_BUFFER_SIZE = 500 * 1024;

export class RunScriptService {
  private readonly executions = new Map<string, RunScriptExecution>();
  // Admission can commit STARTING before its awaited status refresh returns.
  // Keep that owner visible to stop without replacing a still-current process.
  private readonly pendingStarts = new Map<string, RunScriptExecution>();
  private readonly runOutput = new RunScriptOutputBuffer(MAX_OUTPUT_BUFFER_SIZE);
  private readonly postRunOutput = new RunScriptOutputBuffer(MAX_OUTPUT_BUFFER_SIZE);
  private cleanupPromise: Promise<void> | null = null;
  private isShuttingDown = false;
  private shutdownHandlersRegistered = false;

  private createExecution(workspaceId: string, pending = false): RunScriptExecution {
    const execution = new RunScriptExecution(workspaceId, {
      isCurrent: () => this.ownsExecution(workspaceId, execution),
      release: () => {
        if (this.executions.get(workspaceId) === execution) {
          this.executions.delete(workspaceId);
        }
        if (this.pendingStarts.get(workspaceId) === execution) {
          this.pendingStarts.delete(workspaceId);
        }
      },
      appendOutput: (output) => this.runOutput.append(workspaceId, output),
      appendPostRunOutput: (output) => this.postRunOutput.append(workspaceId, output),
    });
    (pending ? this.pendingStarts : this.executions).set(workspaceId, execution);
    return execution;
  }

  private ownsExecution(workspaceId: string, execution: RunScriptExecution): boolean {
    return (
      this.executions.get(workspaceId) === execution ||
      this.pendingStarts.get(workspaceId) === execution
    );
  }

  async startRunScript(workspaceId: string): Promise<{
    success: boolean;
    port?: number;
    pid?: number;
    proxyUrl?: string;
    error?: string;
  }> {
    if (this.isShuttingDown || this.cleanupPromise !== null) {
      return { success: false, error: 'Run scripts are shutting down' };
    }
    if (this.pendingStarts.has(workspaceId)) {
      return { success: false, error: 'Run script is already starting' };
    }
    const execution = this.createExecution(workspaceId, true);
    let admissionStarted = false;
    try {
      const prepared = await this.prepareExecution(workspaceId, execution);
      if (!prepared) {
        return { success: false, error: 'Run script was stopped before it could start' };
      }
      const { cwd, commands } = prepared;
      admissionStarted = true;
      const started = await runScriptStateMachine.start(workspaceId);
      if (!started) {
        const fresh = await workspaceDataService.findById(workspaceId);
        return {
          success: false,
          error: 'Run script is already running',
          pid: fresh?.runScriptPid ?? undefined,
          port: fresh?.runScriptPort ?? undefined,
        };
      }
      if (!execution.canSpawn) {
        // Stop may have completed during the post-CAS admission refresh. If it
        // revoked intent before the CAS, finish cancelling this admission now.
        await this.cancelCommittedAdmission(workspaceId, execution);
        return { success: false, error: 'Run script was stopped before it could start' };
      }
      this.pendingStarts.delete(workspaceId);
      this.executions.set(workspaceId, execution);
      let command = commands.runScriptCommand;
      let port: number | undefined;
      if (command.includes('{port}')) {
        port = await PortAllocationService.findFreePort();
        command = FactoryConfigService.substitutePort(command, port);
      }
      if (!execution.canSpawn) {
        return { success: false, error: 'Run script was stopped before it could start' };
      }
      const startMessage = `\x1b[36m[Factory Factory]\x1b[0m Starting ${command}\n\n`;
      const pid = execution.spawn(command, cwd);
      this.runOutput.set(workspaceId, startMessage);
      this.postRunOutput.clearBuffer(workspaceId);
      return await execution.finishStartup(pid, port, commands.runScriptPostRunCommand, cwd);
    } catch (error) {
      return await this.handleStartError(
        workspaceId,
        toError(error),
        admissionStarted ? execution : undefined
      );
    } finally {
      this.releasePendingStart(workspaceId, execution);
    }
  }

  private async prepareExecution(
    workspaceId: string,
    execution: RunScriptExecution
  ): Promise<{
    cwd: string;
    commands: RunScriptCommandCache & { runScriptCommand: string };
  } | null> {
    const workspace = await workspaceDataService.findById(workspaceId);
    if (!execution.canSpawn) {
      return null;
    }
    if (!workspace) {
      throw new Error('Workspace not found');
    }
    if (!workspace.worktreePath) {
      throw new Error('Workspace worktree not initialized');
    }
    const commands = await this.reconcileWorkspaceCommands(workspace);
    if (!execution.canSpawn) {
      return null;
    }
    if (!commands.runScriptCommand) {
      throw new Error('No run script configured for this workspace');
    }
    return {
      cwd: workspace.worktreePath,
      commands: { ...commands, runScriptCommand: commands.runScriptCommand },
    };
  }

  private async cancelCommittedAdmission(
    workspaceId: string,
    execution: RunScriptExecution
  ): Promise<void> {
    if (this.pendingStarts.get(workspaceId) === execution) {
      await this.stopRunScript(workspaceId);
    }
  }

  private releasePendingStart(
    workspaceId: string,
    execution: RunScriptExecution | undefined
  ): void {
    if (execution && this.pendingStarts.get(workspaceId) === execution) {
      this.pendingStarts.delete(workspaceId);
    }
  }

  private reconcileWorkspaceCommands(workspace: {
    id: string;
    worktreePath: string | null;
    runScriptCommand: string | null;
    runScriptPostRunCommand: string | null;
    runScriptCleanupCommand: string | null;
  }): Promise<RunScriptCommandCache> {
    return runScriptConfigPersistenceService.reconcileWorkspaceCommandCache({
      workspace,
      // Workspace command cache writes are owned by workspace domain writers.
      // We still reconcile to execute canonical commands from factory config.
      persistWorkspaceCommands: async () => Promise.resolve(),
    });
  }

  private async handleStartError(
    workspaceId: string,
    error: Error,
    execution?: RunScriptExecution
  ): Promise<{ success: boolean; error?: string }> {
    logger.error('Failed to start run script', error, { workspaceId });

    // Only transition to FAILED if THIS call initiated the STARTING state
    // If the error is a state machine error (e.g., concurrent start), don't mark as FAILED
    if (
      execution &&
      this.ownsExecution(workspaceId, execution) &&
      error.name !== 'RunScriptStateMachineError'
    ) {
      try {
        const workspace = await workspaceDataService.findById(workspaceId);
        if (
          workspace?.runScriptStatus === 'STARTING' &&
          this.ownsExecution(workspaceId, execution)
        ) {
          await runScriptStateMachine.markFailed(workspaceId);
        }
      } catch (stateError) {
        logger.error('Failed to transition to FAILED state', toError(stateError), {
          workspaceId,
        });
      }
    }

    if (execution && !execution.process && this.executions.get(workspaceId) === execution) {
      this.executions.delete(workspaceId);
    }
    return { success: false, error: error.message };
  }

  async stopRunScript(workspaceId: string): Promise<{ success: boolean; error?: string }> {
    this.pendingStarts.get(workspaceId)?.requestStop();
    try {
      const workspace = await workspaceDataService.findById(workspaceId);
      if (!workspace) {
        throw new Error('Workspace not found');
      }
      const status = workspace.runScriptStatus;
      const pid = workspace.runScriptPid;
      const pending = this.pendingStarts.get(workspaceId);
      pending?.requestStop();
      let execution = this.executions.get(workspaceId) ?? pending;
      if (status === 'IDLE') {
        await runScriptProxyService.stopTunnel(workspaceId);
        return { success: true };
      }
      if (status === 'COMPLETED' || status === 'FAILED') {
        await this.stopTerminalExecution(workspaceId, execution);
        return { success: true };
      }
      if (
        status !== 'STOPPING' &&
        shouldRejectStopWithoutProcess(status, execution?.process, pid)
      ) {
        return { success: false, error: 'No run script is running' };
      }
      // A recovered PID has no local child handle. Keep recovery as a distinct
      // stop attempt rather than fabricating a spawned-process observation.
      execution ??= this.createExecution(workspaceId);
      if (status !== 'STOPPING') {
        const raced = await this.attemptBeginStopping(workspaceId);
        if (raced) {
          await execution.releaseTunnel();
          return { success: true };
        }
      }
      // Revoke auxiliary startup before awaiting the user's cleanup command.
      execution.requestStop();
      if (status !== 'STOPPING') {
        await this.runConfiguredCleanup(workspace);
      }
      await execution.stop(pid);
      await this.finishStoppedExecution(workspaceId, execution);
      return { success: true };
    } catch (error) {
      const normalizedError = toError(error);
      logger.error('Failed to stop run script', normalizedError, { workspaceId });
      return { success: false, error: normalizedError.message };
    }
  }

  private async stopTerminalExecution(
    workspaceId: string,
    execution: RunScriptExecution | undefined
  ): Promise<void> {
    execution?.stopTerminalProcess();
    if (execution && this.executions.get(workspaceId) === execution) {
      this.executions.delete(workspaceId);
    }
    try {
      await runScriptStateMachine.reset(workspaceId);
    } catch {
      /* already transitioned */
    }
    if (execution) {
      await execution.releaseTunnel();
    } else {
      await runScriptProxyService.stopTunnel(workspaceId);
    }
  }

  private async runConfiguredCleanup(
    workspace: RunScriptCommandCache & {
      id: string;
      worktreePath: string | null;
      runScriptPort: number | null;
    }
  ): Promise<void> {
    let command = workspace.runScriptCleanupCommand;
    try {
      command = (await this.reconcileWorkspaceCommands(workspace)).runScriptCleanupCommand;
    } catch (error) {
      logger.warn('Failed to reconcile commands during stop; using cached cleanup', {
        workspaceId: workspace.id,
        error,
      });
    }
    if (command && workspace.worktreePath) {
      await this.runCleanupScript(workspace.id, {
        runScriptCleanupCommand: command,
        worktreePath: workspace.worktreePath,
        runScriptPort: workspace.runScriptPort,
      });
    }
  }

  private async finishStoppedExecution(
    workspaceId: string,
    execution: RunScriptExecution
  ): Promise<void> {
    // A natural exit may already have released this owner and admitted a
    // replacement while the user's cleanup command was still running.
    const current = this.executions.get(workspaceId);
    if (!current || current === execution) {
      await this.completeStoppingAfterStop(workspaceId);
    }
    if (this.executions.get(workspaceId) === execution) {
      this.executions.delete(workspaceId);
    }
    if (this.pendingStarts.get(workspaceId) === execution) {
      this.pendingStarts.delete(workspaceId);
    }
    await execution.releaseTunnel();
  }

  private async attemptBeginStopping(workspaceId: string): Promise<boolean> {
    try {
      await runScriptStateMachine.beginStopping(workspaceId);
      return false; // No race -- continue with stop flow
    } catch (error) {
      // Race: state moved to a terminal state between our read and the CAS write.
      const fresh = await workspaceDataService.findById(workspaceId);
      const freshStatus = fresh?.runScriptStatus;
      if (
        freshStatus === 'COMPLETED' ||
        freshStatus === 'FAILED' ||
        freshStatus === 'IDLE' ||
        freshStatus === 'STOPPING'
      ) {
        logger.debug('beginStopping raced with exit handler, treating as stopped', {
          workspaceId,
          freshStatus,
        });
        return true; // Raced -- caller should return success
      }
      throw error; // Unexpected -- re-throw
    }
  }

  private async completeStoppingAfterStop(workspaceId: string): Promise<void> {
    try {
      await runScriptStateMachine.completeStopping(workspaceId);
    } catch (error) {
      // Exit handler may have raced and already completed STOPPING -> IDLE.
      const fresh = await workspaceDataService.findById(workspaceId);
      if (fresh?.runScriptStatus === 'IDLE') {
        logger.debug('completeStopping raced with exit handler, already IDLE', {
          workspaceId,
        });
        return;
      }
      throw error;
    }
  }

  private async runCleanupScript(
    workspaceId: string,
    workspace: {
      runScriptCleanupCommand: string;
      worktreePath: string;
      runScriptPort: number | null;
    }
  ): Promise<void> {
    await runCleanupScriptProcess(workspaceId, workspace, logger);
  }

  /**
   * Get the status of the run script for a workspace
   */
  async getRunScriptStatus(workspaceId: string) {
    const workspace = await workspaceDataService.findById(workspaceId);
    if (!workspace) {
      throw new Error('Workspace not found');
    }

    // Verify process status via state machine (handles stale process detection)
    const status = await runScriptStateMachine.verifyRunning(workspaceId);

    // Refetch workspace to get fresh data after potential state transition
    const freshWorkspace = await workspaceDataService.findById(workspaceId);
    if (!freshWorkspace) {
      throw new Error('Workspace not found');
    }

    return {
      status,
      pid: freshWorkspace.runScriptPid,
      port: freshWorkspace.runScriptPort,
      proxyUrl: runScriptProxyService.getTunnelUrl(workspaceId),
      startedAt: freshWorkspace.runScriptStartedAt,
      hasRunScript: !!freshWorkspace.runScriptCommand,
      runScriptCommand: freshWorkspace.runScriptCommand,
      runScriptPostRunCommand: freshWorkspace.runScriptPostRunCommand,
      runScriptCleanupCommand: freshWorkspace.runScriptCleanupCommand,
    };
  }

  /**
   * Get the output buffer for a workspace's run script
   */
  getOutputBuffer(workspaceId: string): string {
    return this.runOutput.get(workspaceId);
  }

  /**
   * Evict in-memory run-script buffers/listeners for a workspace.
   * Called when a workspace lifecycle reaches ARCHIVED.
   */
  evictWorkspaceBuffers(workspaceId: string): void {
    this.runOutput.evict(workspaceId);
    this.postRunOutput.evict(workspaceId);
  }

  /**
   * Subscribe to output from a workspace's run script
   * @returns Unsubscribe function
   */
  subscribeToOutput(workspaceId: string, listener: (data: string) => void): () => void {
    return this.runOutput.subscribe(workspaceId, listener);
  }

  /**
   * Get the output buffer for a workspace's postRun script
   */
  getPostRunOutputBuffer(workspaceId: string): string {
    return this.postRunOutput.get(workspaceId);
  }

  /**
   * Subscribe to output from a workspace's postRun script
   * @returns Unsubscribe function
   */
  subscribeToPostRunOutput(workspaceId: string, listener: (data: string) => void): () => void {
    return this.postRunOutput.subscribe(workspaceId, listener);
  }

  cleanup(): Promise<void> {
    if (this.cleanupPromise !== null) {
      return this.cleanupPromise;
    }

    this.cleanupPromise = (async () => {
      logger.info('Cleaning up all running scripts', {
        count: this.executions.size,
      });

      // Close admission for this cleanup lifetime, and capture owners before
      // awaiting stop: an older cleanup may never erase a different owner.
      const captured = new Map(this.executions);
      for (const execution of captured.values()) {
        execution.requestStop();
      }
      for (const pending of this.pendingStarts.values()) {
        pending.requestStop();
      }
      const workspaceIds = Array.from(
        new Set([...this.executions.keys(), ...this.pendingStarts.keys()])
      );
      await Promise.all(
        workspaceIds.map(async (workspaceId) => {
          try {
            await this.stopRunScript(workspaceId);
          } catch (error) {
            logger.error('Failed to stop run script during cleanup', toError(error), {
              workspaceId,
            });
          }
        })
      );

      for (const [workspaceId, execution] of captured) {
        if (this.executions.get(workspaceId) === execution) {
          this.executions.delete(workspaceId);
        }
      }
      // A cancelled admission may still be awaiting its STARTING write. Keep
      // its identity until its caller reconciles that write and exits finally.
      await runScriptProxyService.cleanup();
    })().finally(() => {
      this.cleanupPromise = null;
    });

    return this.cleanupPromise;
  }

  cleanupSync(): void {
    for (const pending of this.pendingStarts.values()) {
      pending.requestStop();
    }
    for (const execution of this.executions.values()) {
      execution.cleanupSync();
    }
    this.executions.clear();
    this.pendingStarts.clear();
    runScriptProxyService.cleanupSync();
    this.runOutput.clear();
    this.postRunOutput.clear();
  }

  /**
   * Register process signal handlers for graceful shutdown.
   * Should be called once for the process-lifetime service instance.
   */
  registerShutdownHandlers(): void {
    if (this.shutdownHandlersRegistered) {
      return;
    }
    this.shutdownHandlersRegistered = true;

    // Register cleanup handlers for graceful shutdown
    // These handlers allow async cleanup (unlike 'exit' which is synchronous)
    // Note: We don't call process.exit() to allow other shutdown handlers to run
    const cleanupOnSignal = (signal: string): void => {
      if (this.isShuttingDown) {
        return;
      }
      this.isShuttingDown = true;
      logger.info(`Received ${signal}, cleaning up run scripts`);
      void this.cleanup().catch((error: unknown) => {
        logger.error('Run script shutdown cleanup failed', toError(error));
        this.cleanupSync();
      });
    };
    process.on('SIGINT', () => cleanupOnSignal('SIGINT'));
    process.on('SIGTERM', () => cleanupOnSignal('SIGTERM'));

    // Fallback synchronous cleanup for 'exit' event
    // This won't run cleanup scripts, but will kill processes
    // Only runs if SIGINT/SIGTERM handlers didn't already clean up
    process.on('exit', () => {
      if (!this.isShuttingDown) {
        this.cleanupSync();
      }
    });
  }
}

export function createRunScriptService(
  options: { registerShutdownHandlers?: boolean } = {}
): RunScriptService {
  const service = new RunScriptService();
  if (options.registerShutdownHandlers) {
    service.registerShutdownHandlers();
  }
  return service;
}
