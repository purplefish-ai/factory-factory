import type { ChildProcess } from 'node:child_process';
import { toError } from '@/backend/lib/error-utils';
import { createLogger } from '@/backend/services/logger.service';
import { workspaceDataService } from '@/backend/services/workspace';
import { FactoryConfigService } from './factory-config.service';
import {
  decodeOutputStream,
  spawnPipedShellCommand,
  treeKillProcess,
  waitForChildProcessExit,
} from './run-script-process-utils';
import { runScriptProxyService, type RunScriptTunnelLease } from './run-script-proxy.service';
import {
  RunScriptStateMachineError,
  runScriptStateMachine,
} from './run-script-state-machine.service';

const logger = createLogger('run-script-execution');
const RUN_SCRIPT_EXIT_STATE_MAX_ATTEMPTS = 3;

type ProcessObservation =
  | { kind: 'preparing' }
  | { kind: 'live'; child: ChildProcess }
  | { kind: 'ended'; child: ChildProcess; code: number | null; signal: string | null };

type ExecutionHooks = {
  isCurrent(): boolean;
  release(): void;
  appendOutput(output: string): void;
  appendPostRunOutput(output: string): void;
};

/** One attempt, including resources and callbacks that can outlive its main process. */
export class RunScriptExecution {
  private state: ProcessObservation = { kind: 'preparing' };
  private stopRequested = false;
  private postRunProcess: ChildProcess | undefined;
  private tunnel: RunScriptTunnelLease | null = null;

  constructor(
    readonly workspaceId: string,
    private readonly hooks: ExecutionHooks
  ) {}

  get observation(): Readonly<ProcessObservation> {
    return this.state;
  }
  get process(): ChildProcess | undefined {
    return this.state.kind === 'preparing' ? undefined : this.state.child;
  }
  get canSpawn(): boolean {
    return this.state.kind === 'preparing' && !this.stopRequested && this.hooks.isCurrent();
  }
  get canStartAuxiliary(): boolean {
    const child = this.process;
    return (
      this.state.kind === 'live' &&
      !this.stopRequested &&
      this.hooks.isCurrent() &&
      child?.exitCode === null &&
      child.signalCode === null
    );
  }
  requestStop(): void {
    this.stopRequested = true;
  }

  attachProcess(child: ChildProcess): void {
    if (!this.canSpawn) {
      throw new Error('Run script was stopped before it could start');
    }
    this.state = { kind: 'live', child };
  }

  spawn(command: string, cwd: string): number {
    if (!this.canSpawn) {
      throw new Error('Run script was stopped before it could start');
    }
    const child = spawnPipedShellCommand(command, cwd, (error) => {
      logger.warn('Run script process failed to spawn', { workspaceId: this.workspaceId, error });
    });
    if (!child.pid) {
      throw new Error('Failed to spawn run script process');
    }
    this.attachProcess(child);
    this.registerProcessHandlers(child, child.pid);
    return child.pid;
  }

  private registerProcessHandlers(child: ChildProcess, pid: number): void {
    const workspaceId = this.workspaceId;
    child.on('exit', (code, signal) => {
      void this.observeExit(code, signal).catch((error) => {
        logger.error('Failed to handle run script exit', toError(error), {
          workspaceId,
          pid,
          code,
          signal,
        });
      });
    });
    decodeOutputStream(child.stdout, this.hooks.appendOutput);
    decodeOutputStream(child.stderr, this.hooks.appendOutput);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('error', (error) =>
        logger.warn('Run script stream error', { workspaceId, error, pid })
      );
    }
    child.on('error', (error) => {
      if (!this.hooks.isCurrent()) {
        return;
      }
      this.state = { kind: 'ended', child, code: null, signal: null };
      logger.error('Run script spawn error', error, { workspaceId, pid });
      this.hooks.release();
      void runScriptStateMachine.markFailed(workspaceId).catch((stateError: unknown) => {
        logger.warn('Failed to transition to FAILED on spawn error', {
          workspaceId,
          error: stateError,
        });
      });
    });
  }

  async observeExit(code: number | null, signal: string | null): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }
    this.state = { kind: 'ended', child, code, signal };
    if (this.hooks.isCurrent()) {
      await this.persistProcessExitState(this.workspaceId, child, code);
    }
    // These resources belong to this attempt even when a replacement has
    // become current during persistence. A lease cannot close its successor.
    await this.killPostRunProcess();
    this.hooks.release();
    await this.releaseTunnel();
  }

  async finishStartup(
    pid: number,
    port: number | undefined,
    postRunCommand: string | null,
    cwd: string
  ): Promise<{ success: boolean; port?: number; pid?: number; proxyUrl?: string; error?: string }> {
    const child = this.process;
    if (this.state.kind === 'ended' && !this.stopRequested) {
      return { success: true, port, pid };
    }
    if (!(child && this.canStartAuxiliary)) {
      return { success: false, error: 'Run script was stopped before it could start' };
    }
    try {
      await runScriptStateMachine.markRunning(this.workspaceId, { pid, port });
      const proxyUrl = port ? await this.ensureTunnel(port) : null;
      if (postRunCommand) {
        void this.startPostRun(postRunCommand, cwd, port).catch((error) => {
          logger.warn('Failed to start postRun script', { workspaceId: this.workspaceId, error });
        });
      }
      return { success: true, port, pid, proxyUrl: proxyUrl ?? undefined };
    } catch (error) {
      return this.handleMarkRunningRace(this.workspaceId, child, pid, port, error);
    }
  }

  private async ensureTunnel(port: number): Promise<string | null> {
    if (!this.canStartAuxiliary) {
      return null;
    }
    const lease = await runScriptProxyService.acquireTunnel(this.workspaceId, port);
    if (!lease) {
      return null;
    }
    if (!this.canStartAuxiliary) {
      await lease.release();
      return null;
    }
    this.tunnel = lease;
    return lease.url;
  }

  async releaseTunnel(): Promise<void> {
    const lease = this.tunnel;
    this.tunnel = null;
    await lease?.release();
  }

  async startPostRun(command: string, cwd: string, port: number | undefined): Promise<void> {
    await Promise.resolve();
    if (!this.canStartAuxiliary) {
      return;
    }
    if (port && command.includes('{port}')) {
      command = FactoryConfigService.substitutePort(command, port);
    }
    const child = spawnPipedShellCommand(command, cwd, (error) => {
      logger.warn('Failed to spawn postRun process', { workspaceId: this.workspaceId, error });
    });
    if (!child.pid) {
      return;
    }
    this.postRunProcess = child;
    const message = `\x1b[36m[Factory Factory]\x1b[0m Starting postRun: ${command}\n`;
    this.hooks.appendOutput(message);
    this.hooks.appendPostRunOutput(message);
    decodeOutputStream(child.stdout, this.hooks.appendPostRunOutput);
    decodeOutputStream(child.stderr, this.hooks.appendPostRunOutput);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('error', (error) =>
        logger.warn('PostRun stream error', { workspaceId: this.workspaceId, error })
      );
    }
    const release = () => {
      if (this.postRunProcess === child) {
        this.postRunProcess = undefined;
      }
    };
    child.on('exit', release);
    child.on('error', (error) => {
      logger.error('PostRun spawn error', error, { workspaceId: this.workspaceId });
      release();
    });
  }

  async killPostRunProcess(): Promise<void> {
    const child = this.postRunProcess;
    if (!child) {
      return;
    }
    if (!child.pid) {
      this.postRunProcess = undefined;
      return;
    }
    await treeKillProcess(
      child.pid,
      'SIGTERM',
      (message, code) => {
        if (code !== 'ESRCH' && !message.includes('No such process')) {
          logger.warn('Failed to tree-kill postRun process', {
            workspaceId: this.workspaceId,
            error: message,
          });
        }
      },
      () => {
        if (this.postRunProcess === child) {
          this.postRunProcess = undefined;
        }
      }
    );
  }

  async stop(pid: number | null): Promise<void> {
    this.requestStop();
    await this.killProcessTree(pid);
    await this.killPostRunProcess();
    await this.waitForProcessExit(pid);
  }

  async killProcessTree(pid: number | null): Promise<void> {
    this.requestStop();
    const targetPid = this.process?.pid ?? pid;
    if (!targetPid) {
      return;
    }
    await treeKillProcess(
      targetPid,
      'SIGTERM',
      (message, code) => {
        if (code !== 'ESRCH' && !message.includes('No such process')) {
          logger.warn('Failed to tree-kill run script process', {
            workspaceId: this.workspaceId,
            error: message,
          });
        }
      },
      () => undefined
    );
  }

  async waitForProcessExit(pid: number | null): Promise<void> {
    await waitForChildProcessExit({
      workspaceId: this.workspaceId,
      childProcess: this.process,
      pid,
      logger,
    });
  }

  stopTerminalProcess(): void {
    const child = this.process;
    this.requestStop();
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
  }

  cleanupSync(): void {
    this.requestStop();
    const mainProcess = this.state.kind === 'live' ? this.state.child : undefined;
    for (const child of [mainProcess, this.postRunProcess]) {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      } catch {
        /* forced shutdown */
      }
    }
  }

  private async persistProcessExitState(
    workspaceId: string,
    childProcess: ChildProcess,
    code: number | null
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= RUN_SCRIPT_EXIT_STATE_MAX_ATTEMPTS; attempt += 1) {
      if (!this.hooks.isCurrent()) {
        logger.info('Stopping run script exit persistence after ownership changed', {
          workspaceId,
          exitingPid: childProcess.pid,
          attempt,
        });
        return;
      }

      try {
        await this.transitionProcessExitState(workspaceId, code);
        return;
      } catch (error) {
        const reconciliation = await this.reconcileProcessExitTransitionError(workspaceId, error);
        if (reconciliation.isConsistent) {
          return;
        }
        lastError = reconciliation.error;

        if (attempt < RUN_SCRIPT_EXIT_STATE_MAX_ATTEMPTS) {
          logger.warn('Failed to persist run script exit state; retrying', {
            workspaceId,
            attempt,
            maxAttempts: RUN_SCRIPT_EXIT_STATE_MAX_ATTEMPTS,
            error: toError(lastError).message,
          });
        }
      }
    }

    const error = toError(lastError);
    logger.error('Failed to persist run script exit state after retries', error, {
      workspaceId,
      maxAttempts: RUN_SCRIPT_EXIT_STATE_MAX_ATTEMPTS,
    });
    throw error;
  }

  private async reconcileProcessExitTransitionError(
    workspaceId: string,
    error: unknown
  ): Promise<{ isConsistent: boolean; error: unknown }> {
    if (!(error instanceof RunScriptStateMachineError)) {
      return { isConsistent: false, error };
    }

    try {
      const refreshed = await workspaceDataService.findById(workspaceId);
      const status = refreshed?.runScriptStatus;
      const isConsistent = status === 'IDLE' || status === 'COMPLETED' || status === 'FAILED';
      if (isConsistent) {
        logger.debug('Run script exit transition raced with a consistent state', {
          workspaceId,
          status,
        });
      }
      return { isConsistent, error };
    } catch (refreshError) {
      return { isConsistent: false, error: refreshError };
    }
  }

  private async transitionProcessExitState(
    workspaceId: string,
    code: number | null
  ): Promise<void> {
    const workspace = await workspaceDataService.findById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found while persisting run script exit: ${workspaceId}`);
    }

    if (!this.hooks.isCurrent()) {
      return;
    }
    const status = workspace.runScriptStatus;
    if (status === 'STOPPING') {
      await runScriptStateMachine.completeStopping(workspaceId);
      return;
    }

    if (status === 'IDLE' || status === 'COMPLETED' || status === 'FAILED') {
      logger.debug(`Process exited while in ${status} state, skipping exit transition`, {
        workspaceId,
      });
      return;
    }

    if (code === 0) {
      await runScriptStateMachine.markCompleted(workspaceId);
    } else {
      await runScriptStateMachine.markFailed(workspaceId);
    }
  }

  private async handleMarkRunningRace(
    workspaceId: string,
    childProcess: ChildProcess,
    pid: number,
    port: number | undefined,
    markRunningError: unknown
  ): Promise<{ success: boolean; port?: number; pid?: number; proxyUrl?: string; error?: string }> {
    // Check if the process already exited and the exit handler transitioned the state
    const ws = await workspaceDataService.findById(workspaceId);
    const currentStatus = ws?.runScriptStatus;
    if (currentStatus === 'COMPLETED' || currentStatus === 'FAILED') {
      logger.info('Process exited before markRunning -- exit handler already transitioned state', {
        workspaceId,
        pid,
        currentStatus,
      });
      return { success: true, port, pid };
    }
    // Concurrent stop completed (STARTING -> STOPPING -> IDLE) while we were spawning.
    // Kill the orphaned process so it doesn't leak.
    if (currentStatus === 'IDLE' || currentStatus === 'STOPPING') {
      logger.info('Concurrent stop completed before markRunning -- killing orphaned process', {
        workspaceId,
        pid,
        currentStatus,
      });
      try {
        childProcess.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      this.hooks.release();
      return { success: false, error: 'Run script was stopped before it could start' };
    }
    throw markRunningError;
  }
}
