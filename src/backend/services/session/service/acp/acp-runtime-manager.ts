import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ContentBlock, SessionConfigOption } from '@agentclientprotocol/sdk';
import pLimit from 'p-limit';
import { createLogger } from '@/backend/services/logger.service';
import type {
  SubagentBrowseCapability,
  SubagentListParams,
  SubagentListResult,
  SubagentReadParams,
  SubagentReadResult,
} from '@/shared/acp-protocol/subagents';
import { AcpClientFactory, cleanupFailedAcpClientCreation } from './acp-client-factory';
import type { AcpProcessHandle } from './acp-process-handle';
import { AcpPromptController } from './acp-prompt-controller';
import { AcpRuntimeConfigController } from './acp-runtime-config-controller';
import type {
  AcpRuntimeContext,
  AcpRuntimeCreatedCallback,
  AcpRuntimeMetadata,
  AcpStartupSignal,
} from './acp-runtime-contracts';
import type { AcpRuntimeEventHandlers, AcpRuntimePurpose } from './acp-runtime-events';
import { createExitFence, dispatchAcpRuntimeExit, guardExit } from './acp-runtime-exit-handler';
import {
  type AcpClientCreationOperation,
  AcpRuntimeQuiescence,
  raceWithSoftTimeout,
} from './acp-runtime-quiescence';
import { AcpSubagentBrowser } from './acp-subagent-browser';
import type { AcpClientOptions } from './types';

export type { AcpRuntimeCreatedCallback } from './acp-runtime-contracts';
export { AcpBrowseSessionUnavailableError, PromptTimeoutError } from './acp-runtime-errors';

const logger = createLogger('acp-runtime-manager');

export class AcpRuntimeManager {
  private readonly clientFactory: AcpClientFactory;
  private readonly sessions = new Map<string, AcpProcessHandle>();
  private readonly promptController = new AcpPromptController({
    isCurrentHandle: (sessionId, handle) => this.sessions.get(sessionId) === handle,
    stopClient: (sessionId) => this.stopClient(sessionId),
  });
  private readonly configController = new AcpRuntimeConfigController();
  private readonly browseOnlySessions = new Set<string>();
  private readonly pendingCreation = new Map<string, Promise<AcpProcessHandle>>();
  private readonly stoppingInProgress = new Set<string>();
  private readonly stopOperations = new Map<string, Promise<void>>();
  private readonly subagentBrowser = new AcpSubagentBrowser();
  private readonly quiescence = new AcpRuntimeQuiescence({
    stopClient: (sessionId) => this.stopClient(sessionId),
  });
  private readonly managedStopChildren = new WeakSet<ChildProcess>();
  private readonly runtimeMetadata = new WeakMap<ChildProcess, AcpRuntimeMetadata>();
  private readonly exitHandling = new Map<string, Promise<void>>();
  private readonly creationLocks = new Map<string, ReturnType<typeof pLimit>>();
  private readonly lockRefCounts = new Map<string, number>();
  private readonly shutdownWaiters = new Set<() => void>();
  private readonly sessionStopWaiters = new Map<string, Set<() => void>>();
  private isShuttingDown = false;
  private onClientCreatedCallback: AcpRuntimeCreatedCallback | null = null;
  constructor(options?: { acpStartupTimeoutMs?: number }) {
    this.clientFactory = new AcpClientFactory(options);
  }
  setAcpStartupTimeoutMs(timeoutMs: number): void {
    this.clientFactory.setAcpStartupTimeoutMs(timeoutMs);
  }
  configureEnvironment(options: {
    preferSourceEntrypoint: boolean;
    childProcessEnvProvider: () => NodeJS.ProcessEnv;
  }): void {
    this.clientFactory.configureEnvironment(options);
  }
  setOnClientCreated(callback: AcpRuntimeCreatedCallback): void {
    this.onClientCreatedCallback = callback;
  }
  isStopInProgress(sessionId: string): boolean {
    return this.stoppingInProgress.has(sessionId);
  }
  getClient(sessionId: string): AcpProcessHandle | undefined {
    return this.browseOnlySessions.has(sessionId) ? undefined : this.getBrowseClient(sessionId);
  }
  getBrowseClient(sessionId: string): AcpProcessHandle | undefined {
    const handle = this.sessions.get(sessionId);
    return handle?.isRunning() ? handle : undefined;
  }
  isBrowseOnlySession(sessionId: string): boolean {
    const hasRuntime = this.sessions.has(sessionId) || this.pendingCreation.has(sessionId);
    const fencePurpose = this.quiescence.getTrackedSessionPurpose(sessionId);
    return (
      (hasRuntime || fencePurpose !== null) &&
      (!hasRuntime || this.browseOnlySessions.has(sessionId)) &&
      (fencePurpose === null || fencePurpose === 'browse')
    );
  }
  hasClientCreationOperation(sessionId: string): boolean {
    return this.quiescence.getTrackedSessionPurpose(sessionId) !== null;
  }
  getPendingClient(sessionId: string): Promise<AcpProcessHandle> | undefined {
    return this.pendingCreation.get(sessionId);
  }
  runClientCreationOperation<T>(
    sessionId: string,
    purpose: AcpRuntimePurpose,
    operation: (registration: AcpClientCreationOperation) => Promise<T>
  ): Promise<T> {
    if (this.isShuttingDown) {
      return Promise.reject(this.createShutdownError(sessionId));
    }
    return this.quiescence.runClientCreationOperation(sessionId, purpose, operation);
  }
  stopAndQuiesce(sessionId: string): Promise<void> {
    return this.quiescence.stopAndQuiesce(sessionId);
  }
  getSubagentBrowseCapability(sessionId: string): SubagentBrowseCapability | null {
    return this.subagentBrowser.getCapability(this.getBrowseClient(sessionId));
  }

  listSubagents(
    sessionId: string,
    input: Omit<SubagentListParams, 'sessionId'>
  ): Promise<SubagentListResult> {
    return this.subagentBrowser.listSubagents(this.getBrowseClient(sessionId), input);
  }

  readSubagentTranscript(
    sessionId: string,
    input: Omit<SubagentReadParams, 'sessionId'>
  ): Promise<SubagentReadResult> {
    return this.subagentBrowser.readSubagentTranscript(this.getBrowseClient(sessionId), input);
  }

  async getOrCreateClient(
    sessionId: string,
    options: AcpClientOptions,
    handlers: AcpRuntimeEventHandlers,
    context: AcpRuntimeContext
  ): Promise<AcpProcessHandle> {
    guardExit(sessionId);
    if (this.isShuttingDown) {
      throw this.createShutdownError(sessionId);
    }
    let lock = this.creationLocks.get(sessionId);
    if (!lock) {
      lock = pLimit(1);
      this.creationLocks.set(sessionId, lock);
      this.lockRefCounts.set(sessionId, 0);
    }

    const currentCount = this.lockRefCounts.get(sessionId) ?? 0;
    this.lockRefCounts.set(sessionId, currentCount + 1);

    return await lock(async () => {
      try {
        const exitHandling = this.exitHandling.get(sessionId);
        if (exitHandling) {
          await exitHandling;
        }
        if (this.isShuttingDown) {
          throw this.createShutdownError(sessionId);
        }

        const existing = this.getBrowseClient(sessionId);
        if (existing?.isRunning()) {
          this.promoteForActiveUse(sessionId, options, existing);
          logger.debug('Returning existing running ACP client', { sessionId });
          return existing;
        }

        const pending = this.pendingCreation.get(sessionId);
        if (pending) {
          logger.debug('Waiting for pending ACP client creation', { sessionId });
          const handle = await pending;
          this.promoteForActiveUse(sessionId, options, handle);
          return handle;
        }

        logger.info('Creating new ACP client', { sessionId, provider: options.provider });
        this.recordClientPurpose(sessionId, options);
        const createPromise = this.createClient(sessionId, options, handlers, context, {
          incarnationId: randomUUID(),
          purpose: options.purpose ?? 'active',
          installed: false,
        });
        this.pendingCreation.set(sessionId, createPromise);

        try {
          return await createPromise;
        } finally {
          this.pendingCreation.delete(sessionId);
          this.clearBrowseOnlyPurposeIfUnused(sessionId);
        }
      } finally {
        const refCount = this.lockRefCounts.get(sessionId) ?? 1;
        const newCount = refCount - 1;
        if (newCount <= 0) {
          this.creationLocks.delete(sessionId);
          this.lockRefCounts.delete(sessionId);
        } else {
          this.lockRefCounts.set(sessionId, newCount);
        }
      }
    });
  }

  private promoteForActiveUse(
    sessionId: string,
    options: AcpClientOptions,
    handle: AcpProcessHandle
  ): void {
    if (options.purpose !== 'browse') {
      this.browseOnlySessions.delete(sessionId);
      const metadata = this.runtimeMetadata.get(handle.child);
      if (metadata) {
        metadata.purpose = 'active';
      }
    }
  }

  private recordClientPurpose(sessionId: string, options: AcpClientOptions): void {
    if (options.purpose === 'browse') {
      this.browseOnlySessions.add(sessionId);
      return;
    }
    this.browseOnlySessions.delete(sessionId);
  }

  private clearBrowseOnlyPurposeIfUnused(sessionId: string): void {
    if (!(this.sessions.has(sessionId) || this.pendingCreation.has(sessionId))) {
      this.browseOnlySessions.delete(sessionId);
    }
  }

  private async createClient(
    sessionId: string,
    options: AcpClientOptions,
    handlers: AcpRuntimeEventHandlers,
    context: AcpRuntimeContext,
    metadata: AcpRuntimeMetadata
  ): Promise<AcpProcessHandle> {
    if (this.isShuttingDown) {
      throw this.createShutdownError(sessionId);
    }

    const shutdownSignal = this.createShutdownSignal(sessionId);
    const stopSignal = this.createSessionStopSignal(sessionId);
    try {
      const handle = await this.clientFactory.createClient({
        sessionId,
        options,
        handlers,
        metadata,
        shutdownSignal,
        stopSignal,
        shouldDispatchRuntimeError: (child) =>
          !metadata.installed || this.sessions.get(sessionId)?.child === child,
      });

      if (this.isShuttingDown) {
        await cleanupFailedAcpClientCreation(handle.child, sessionId);
        throw this.createShutdownError(sessionId);
      }
      if (this.stoppingInProgress.has(sessionId)) {
        await cleanupFailedAcpClientCreation(handle.child, sessionId);
        throw this.createStopRequestedError(sessionId);
      }

      this.runtimeMetadata.set(handle.child, metadata);
      this.sessions.set(sessionId, handle);
      metadata.installed = true;
      this.recordClientPurpose(sessionId, options);
      this.wireChildExitHandler(sessionId, handle.child, handlers, metadata);
      await this.notifyClientCreated(sessionId, handle, context, handlers);
      return handle;
    } finally {
      shutdownSignal.dispose();
      stopSignal.dispose();
    }
  }

  private createShutdownError(sessionId: string): Error {
    return new Error(`ACP runtime manager is shutting down; cannot create client ${sessionId}`);
  }

  private createStopRequestedError(sessionId: string): Error {
    return new Error(`ACP session stop requested; cannot create client ${sessionId}`);
  }

  beginShutdown(): string[] {
    const sessionIds = new Set([
      ...this.sessions.keys(),
      ...this.pendingCreation.keys(),
      ...this.creationLocks.keys(),
      ...this.quiescence.getTrackedSessionIds(),
    ]);

    if (!this.isShuttingDown) {
      this.isShuttingDown = true;
      for (const rejectShutdown of this.shutdownWaiters) {
        rejectShutdown();
      }
      this.shutdownWaiters.clear();
    }

    return [...sessionIds];
  }

  private beginSessionStop(sessionId: string): void {
    this.stoppingInProgress.add(sessionId);

    const stopWaiters = this.sessionStopWaiters.get(sessionId);
    if (!stopWaiters) {
      return;
    }

    for (const rejectStop of stopWaiters) {
      rejectStop();
    }
    this.sessionStopWaiters.delete(sessionId);
  }

  private createShutdownSignal(sessionId: string): AcpStartupSignal {
    let rejectShutdown!: () => void;
    const promise = new Promise<never>((_resolve, reject) => {
      rejectShutdown = () => reject(this.createShutdownError(sessionId));
    });

    if (this.isShuttingDown) {
      rejectShutdown();
    } else {
      this.shutdownWaiters.add(rejectShutdown);
    }

    return {
      promise,
      dispose: () => {
        this.shutdownWaiters.delete(rejectShutdown);
      },
    };
  }

  private createSessionStopSignal(sessionId: string): AcpStartupSignal {
    let rejectStop!: () => void;
    const promise = new Promise<never>((_resolve, reject) => {
      rejectStop = () => reject(this.createStopRequestedError(sessionId));
    });

    if (this.stoppingInProgress.has(sessionId)) {
      rejectStop();
    } else {
      const waiters = this.sessionStopWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(rejectStop);
      this.sessionStopWaiters.set(sessionId, waiters);
    }

    return {
      promise,
      dispose: () => {
        const waiters = this.sessionStopWaiters.get(sessionId);
        if (!waiters) {
          return;
        }
        waiters.delete(rejectStop);
        if (waiters.size === 0) {
          this.sessionStopWaiters.delete(sessionId);
        }
      },
    };
  }

  private wireChildExitHandler(
    sessionId: string,
    child: ChildProcess,
    handlers: AcpRuntimeEventHandlers,
    runtime: AcpRuntimeMetadata
  ): void {
    child.once('exit', (code) => {
      const classification = this.classifyChildExit(sessionId, child, code);
      if (classification === null) {
        this.clearBrowseOnlyPurposeIfUnused(sessionId);
        return;
      }

      this.pendingCreation.delete(sessionId);

      const [exitHandling, releaseExitHandling] = createExitFence();
      this.exitHandling.set(sessionId, exitHandling);
      void dispatchAcpRuntimeExit(handlers, {
        sessionId,
        exitCode: code,
        incarnationId: runtime.incarnationId,
        ...classification,
      }).finally(() => {
        if (this.exitHandling.get(sessionId) === exitHandling) {
          this.exitHandling.delete(sessionId);
        }
        this.clearBrowseOnlyPurposeIfUnused(sessionId);
        releaseExitHandling();
      });
    });
  }

  private classifyChildExit(
    sessionId: string,
    child: ChildProcess,
    code: number | null
  ): { managed: boolean; purpose: AcpRuntimePurpose } | null {
    const purpose = this.runtimeMetadata.get(child)?.purpose ?? 'active';
    const current = this.sessions.get(sessionId);
    const managed =
      this.managedStopChildren.delete(child) || this.stoppingInProgress.has(sessionId);

    if (current?.child === child) {
      this.sessions.delete(sessionId);
    } else if (current) {
      logger.debug('Skipping exit handler - stale ACP process exited', {
        sessionId,
        code,
        pid: child.pid,
        currentPid: current.getPid(),
      });
      return null;
    }

    if (!current && managed) {
      logger.debug('Skipping exit handler - managed stop process exited', { sessionId, code });
      return null;
    }

    return { managed, purpose };
  }

  private async notifyClientCreated(
    sessionId: string,
    handle: AcpProcessHandle,
    context: AcpRuntimeContext,
    handlers: AcpRuntimeEventHandlers
  ): Promise<void> {
    if (this.onClientCreatedCallback) {
      this.onClientCreatedCallback(sessionId, handle, context);
    }

    if (handlers.onSessionId) {
      try {
        await handlers.onSessionId(sessionId, handle.providerSessionId);
      } catch (error) {
        logger.warn('Failed to handle ACP session ID event', {
          sessionId,
          providerSessionId: handle.providerSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  stopClient(sessionId: string): Promise<void> {
    const existingStop = this.stopOperations.get(sessionId);
    if (existingStop) {
      logger.debug('ACP session stop already in progress', { sessionId });
      return existingStop;
    }

    let trackedStop: Promise<void>;
    trackedStop = this.stopClientOnce(sessionId).finally(() => {
      if (this.stopOperations.get(sessionId) === trackedStop) {
        this.stopOperations.delete(sessionId);
      }
    });
    this.stopOperations.set(sessionId, trackedStop);
    return trackedStop;
  }

  private async stopClientOnce(sessionId: string): Promise<void> {
    const pendingCreation = this.pendingCreation.get(sessionId);
    const initialHandle = this.sessions.get(sessionId);
    if (!(initialHandle || pendingCreation)) {
      return;
    }

    this.beginSessionStop(sessionId);
    let stoppedHandle: AcpProcessHandle | undefined;
    try {
      if (pendingCreation) {
        await raceWithSoftTimeout(
          pendingCreation.catch(() => undefined),
          5000
        );
      }

      const handle = this.sessions.get(sessionId) ?? initialHandle;
      if (!handle) {
        return;
      }
      stoppedHandle = handle;

      this.managedStopChildren.add(handle.child);

      // Cancel prompt if in flight
      if (handle.isPromptInFlight) {
        try {
          await this.promptController.cancelPrompt(sessionId, handle);
        } catch (error) {
          logger.debug('Failed to cancel prompt during stop (expected)', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Wait for exit or timeout
      const exitPromise = new Promise<void>((resolve) => {
        handle.child.on('exit', () => resolve());
        // If already exited, resolve immediately
        if (handle.child.exitCode !== null) {
          resolve();
        }
      });

      // Send SIGTERM after registering exit listener to avoid missing fast exits.
      handle.child.kill('SIGTERM');

      await raceWithSoftTimeout(exitPromise, 5000);

      // Escalate to SIGKILL if still alive
      if (handle.child.exitCode === null) {
        logger.warn('ACP process did not exit after SIGTERM, escalating to SIGKILL', {
          sessionId,
          pid: handle.getPid(),
        });
        handle.child.kill('SIGKILL');
      }
    } finally {
      this.stoppingInProgress.delete(sessionId);
      const current = this.sessions.get(sessionId);
      if (current === stoppedHandle) {
        this.sessions.delete(sessionId);
        this.browseOnlySessions.delete(sessionId);
      }
    }
  }

  async sendPrompt(
    sessionId: string,
    prompt: ContentBlock[],
    timeoutMs?: number
  ): Promise<{ stopReason: string }> {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      throw new Error(`No ACP session found for sessionId: ${sessionId}`);
    }

    return await this.promptController.sendPrompt(sessionId, handle, prompt, timeoutMs);
  }

  /** Returns true when a prompt was actually in flight and got cancelled. */
  async cancelPrompt(sessionId: string): Promise<boolean> {
    return await this.promptController.cancelPrompt(sessionId, this.sessions.get(sessionId));
  }

  private requireInstalledHandle(sessionId: string): AcpProcessHandle {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      throw new Error(`No ACP session found for sessionId: ${sessionId}`);
    }
    return handle;
  }

  setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]> {
    return this.configController.setConfigOption(
      this.requireInstalledHandle(sessionId),
      configId,
      value
    );
  }

  setSessionMode(sessionId: string, modeId: string): Promise<SessionConfigOption[]> {
    return this.configController.setSessionMode(this.requireInstalledHandle(sessionId), modeId);
  }

  setSessionModel(sessionId: string, modelId: string): Promise<SessionConfigOption[]> {
    return this.configController.setSessionModel(this.requireInstalledHandle(sessionId), modelId);
  }

  async stopAllClients(timeoutMs = 5000): Promise<void> {
    this.beginShutdown();

    await this.stopCurrentClients(timeoutMs);
    await this.waitForPendingCreations(timeoutMs);
    await this.quiescence.waitForAll();
    await this.stopCurrentClients(timeoutMs);

    this.sessions.clear();
    this.pendingCreation.clear();
    this.creationLocks.clear();
    this.lockRefCounts.clear();
    this.shutdownWaiters.clear();
    this.sessionStopWaiters.clear();

    logger.info('All ACP clients stopped and cleaned up');
  }

  private async stopCurrentClients(timeoutMs: number): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    const stopPromises = sessionIds.map((sessionId) =>
      raceWithSoftTimeout(this.stopClient(sessionId), timeoutMs)
    );

    await Promise.all(stopPromises);
  }

  private async waitForPendingCreations(timeoutMs: number): Promise<void> {
    const pendingCreations = [...this.pendingCreation.values()];
    if (pendingCreations.length === 0) {
      return;
    }

    await raceWithSoftTimeout(
      Promise.allSettled(pendingCreations).then(() => undefined),
      timeoutMs
    );
  }

  getAllClients(): IterableIterator<[string, AcpProcessHandle]> {
    return this.sessions.entries();
  }

  isSessionRunning(sessionId: string): boolean {
    return this.getClient(sessionId) !== undefined;
  }

  isSessionWorking(sessionId: string): boolean {
    const handle = this.sessions.get(sessionId);
    return handle?.isPromptInFlight ?? false;
  }

  isAnySessionWorking(sessionIds: string[]): boolean {
    return sessionIds.some((id) => this.isSessionWorking(id));
  }

  getAllActiveProcesses(): Array<{
    sessionId: string;
    pid: number | undefined;
    status: string;
    isRunning: boolean;
    isPromptInFlight: boolean;
    provider: string;
  }> {
    const processes: Array<{
      sessionId: string;
      pid: number | undefined;
      status: string;
      isRunning: boolean;
      isPromptInFlight: boolean;
      provider: string;
    }> = [];
    for (const [sessionId, handle] of this.sessions) {
      processes.push({
        sessionId,
        pid: handle.getPid(),
        status: handle.isRunning() ? 'running' : 'stopped',
        isRunning: handle.isRunning(),
        isPromptInFlight: handle.isPromptInFlight,
        provider: handle.provider,
      });
    }
    return processes;
  }
}

function createAcpRuntimeManager(): AcpRuntimeManager {
  return new AcpRuntimeManager();
}

export const acpRuntimeManager = createAcpRuntimeManager();
