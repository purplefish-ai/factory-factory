import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';
import { createLogger } from '@/backend/services/logger.service';
import { type AcpClientFactory, cleanupFailedAcpClientCreation } from './acp-client-factory';
import type { AcpProcessHandle } from './acp-process-handle';
import type {
  AcpActiveProcessSnapshot,
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
import type { AcpClientOptions } from './types';

const logger = createLogger('acp-runtime-supervisor');
const STOP_TIMEOUT_MS = 5000;

export type AcpRuntimeSupervisorDependencies = {
  clientFactory: Pick<AcpClientFactory, 'createClient'>;
  cancelPrompt(sessionId: string, handle: AcpProcessHandle): Promise<boolean>;
};

export class AcpRuntimeSupervisor {
  private readonly clientFactory: Pick<AcpClientFactory, 'createClient'>;
  private readonly cancelPrompt: AcpRuntimeSupervisorDependencies['cancelPrompt'];
  private readonly sessions = new Map<string, AcpProcessHandle>();
  private readonly browseOnlySessions = new Set<string>();
  private readonly pendingCreation = new Map<string, Promise<AcpProcessHandle>>();
  private readonly stoppingInProgress = new Set<string>();
  private readonly stopOperations = new Map<string, Promise<void>>();
  private readonly managedStopChildren = new WeakSet<ChildProcess>();
  private readonly runtimeMetadata = new WeakMap<ChildProcess, AcpRuntimeMetadata>();
  private readonly exitHandling = new Map<string, Promise<void>>();
  private readonly creationLocks = new Map<string, ReturnType<typeof pLimit>>();
  private readonly lockRefCounts = new Map<string, number>();
  private readonly stopGenerations = new Map<string, number>();
  private readonly shutdownWaiters = new Set<() => void>();
  private readonly sessionStopWaiters = new Map<string, Set<() => void>>();
  private readonly quiescence: AcpRuntimeQuiescence;
  private isShuttingDown = false;
  private onClientCreatedCallback: AcpRuntimeCreatedCallback | null = null;

  constructor(dependencies: AcpRuntimeSupervisorDependencies) {
    this.clientFactory = dependencies.clientFactory;
    this.cancelPrompt = dependencies.cancelPrompt;
    this.quiescence = new AcpRuntimeQuiescence({
      stopClient: (sessionId) => this.stopClient(sessionId),
    });
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

  getInstalledHandle(sessionId: string): AcpProcessHandle | undefined {
    return this.sessions.get(sessionId);
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
    if (this.stopOperations.has(sessionId) || this.stoppingInProgress.has(sessionId)) {
      throw this.createStopRequestedError(sessionId);
    }

    const stopGeneration = this.getStopGeneration(sessionId);
    const lock = this.acquireCreationLock(sessionId);
    return await lock(async () => {
      try {
        await this.exitHandling.get(sessionId);
        this.throwIfCreationCancelled(sessionId, stopGeneration);

        const existing = this.getBrowseClient(sessionId);
        if (existing) {
          this.promoteForActiveUse(sessionId, options, existing);
          return existing;
        }

        const pending = this.pendingCreation.get(sessionId);
        if (pending) {
          const handle = await pending;
          this.promoteForActiveUse(sessionId, options, handle);
          return handle;
        }

        this.recordClientPurpose(sessionId, options);
        const createPromise = this.createClient(
          sessionId,
          options,
          handlers,
          context,
          {
            incarnationId: randomUUID(),
            purpose: options.purpose ?? 'active',
            installed: false,
          },
          stopGeneration
        );
        this.pendingCreation.set(sessionId, createPromise);
        try {
          return await createPromise;
        } finally {
          if (this.pendingCreation.get(sessionId) === createPromise) {
            this.pendingCreation.delete(sessionId);
          }
          this.clearBrowseOnlyPurposeIfUnused(sessionId);
        }
      } finally {
        this.releaseCreationLock(sessionId);
      }
    });
  }

  isCurrentHandle(sessionId: string, handle: AcpProcessHandle): boolean {
    return this.sessions.get(sessionId) === handle;
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

  stopClient(sessionId: string): Promise<void> {
    const existingStop = this.stopOperations.get(sessionId);
    if (existingStop) {
      return existingStop;
    }

    let trackedStop: Promise<void>;
    trackedStop = this.stopClientOnce(sessionId).finally(() => {
      if (this.stopOperations.get(sessionId) === trackedStop) {
        this.stopOperations.delete(sessionId);
      }
      this.clearStopGenerationIfIdle(sessionId);
    });
    this.stopOperations.set(sessionId, trackedStop);
    return trackedStop;
  }

  async stopAllClients(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
    this.beginShutdown();
    const failures: unknown[] = [];
    try {
      await this.captureShutdownFailure(failures, async () => {
        failures.push(...(await this.stopCurrentClients(timeoutMs)));
      });
      await this.captureShutdownFailure(failures, () => this.waitForPendingCreations(timeoutMs));
      await this.captureShutdownFailure(failures, () => this.quiescence.waitForAll());
      await this.captureShutdownFailure(failures, async () => {
        failures.push(...(await this.stopCurrentClients(timeoutMs)));
      });
    } finally {
      this.clearRegistries();
    }
    logger.info('All ACP clients stopped and cleaned up');
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  getAllClients(): IterableIterator<[string, AcpProcessHandle]> {
    return this.sessions.entries();
  }

  isSessionRunning(sessionId: string): boolean {
    return this.getClient(sessionId) !== undefined;
  }

  isSessionWorking(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isPromptInFlight ?? false;
  }

  isAnySessionWorking(sessionIds: string[]): boolean {
    return sessionIds.some((sessionId) => this.isSessionWorking(sessionId));
  }

  getAllActiveProcesses(): AcpActiveProcessSnapshot[] {
    return [...this.sessions].map(([sessionId, handle]) => {
      const isRunning = handle.isRunning();
      return {
        sessionId,
        pid: handle.getPid(),
        status: isRunning ? 'running' : 'stopped',
        isRunning,
        isPromptInFlight: handle.isPromptInFlight,
        provider: handle.provider,
      };
    });
  }

  private acquireCreationLock(sessionId: string): ReturnType<typeof pLimit> {
    let lock = this.creationLocks.get(sessionId);
    if (!lock) {
      lock = pLimit(1);
      this.creationLocks.set(sessionId, lock);
      this.lockRefCounts.set(sessionId, 0);
    }
    this.lockRefCounts.set(sessionId, (this.lockRefCounts.get(sessionId) ?? 0) + 1);
    return lock;
  }

  private releaseCreationLock(sessionId: string): void {
    const nextCount = (this.lockRefCounts.get(sessionId) ?? 1) - 1;
    if (nextCount <= 0) {
      this.creationLocks.delete(sessionId);
      this.lockRefCounts.delete(sessionId);
      this.clearStopGenerationIfIdle(sessionId);
      return;
    }
    this.lockRefCounts.set(sessionId, nextCount);
  }

  private promoteForActiveUse(
    sessionId: string,
    options: AcpClientOptions,
    handle: AcpProcessHandle
  ): void {
    if (options.purpose === 'browse') {
      return;
    }
    this.browseOnlySessions.delete(sessionId);
    const metadata = this.runtimeMetadata.get(handle.child);
    if (metadata) {
      metadata.purpose = 'active';
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
    metadata: AcpRuntimeMetadata,
    stopGeneration: number
  ): Promise<AcpProcessHandle> {
    if (this.isShuttingDown) {
      throw this.createShutdownError(sessionId);
    }
    const shutdownSignal = this.createShutdownSignal(sessionId);
    const stopSignal = this.createSessionStopSignal(sessionId);
    let startupActive = true;
    try {
      const handle = await this.clientFactory.createClient({
        sessionId,
        options,
        handlers,
        metadata,
        shutdownSignal,
        stopSignal,
        shouldDispatchRuntimeError: (child) =>
          startupActive ||
          (metadata.installed &&
            !this.isCreationCancelled(sessionId, stopGeneration) &&
            this.sessions.get(sessionId)?.child === child),
      });
      startupActive = false;
      const cancellation = this.getCreationCancellationError(sessionId, stopGeneration);
      if (cancellation) {
        await cleanupFailedAcpClientCreation(handle.child, sessionId);
        throw cancellation;
      }

      this.runtimeMetadata.set(handle.child, metadata);
      this.sessions.set(sessionId, handle);
      metadata.installed = true;
      this.recordClientPurpose(sessionId, options);
      this.wireChildExitHandler(sessionId, handle.child, handlers, metadata);
      await this.notifyClientCreated(sessionId, handle, context, handlers);
      const notificationCancellation = this.getCreationCancellationError(sessionId, stopGeneration);
      if (notificationCancellation) {
        if (this.sessions.get(sessionId) === handle) {
          this.sessions.delete(sessionId);
          this.browseOnlySessions.delete(sessionId);
        }
        this.managedStopChildren.add(handle.child);
        await cleanupFailedAcpClientCreation(handle.child, sessionId);
        throw notificationCancellation;
      }
      return handle;
    } finally {
      startupActive = false;
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

  private getStopGeneration(sessionId: string): number {
    return this.stopGenerations.get(sessionId) ?? 0;
  }

  private isCreationCancelled(sessionId: string, stopGeneration: number): boolean {
    return this.isShuttingDown || this.getStopGeneration(sessionId) !== stopGeneration;
  }

  private getCreationCancellationError(
    sessionId: string,
    stopGeneration: number
  ): Error | undefined {
    if (this.isShuttingDown) {
      return this.createShutdownError(sessionId);
    }
    if (this.getStopGeneration(sessionId) !== stopGeneration) {
      return this.createStopRequestedError(sessionId);
    }
    return undefined;
  }

  private throwIfCreationCancelled(sessionId: string, stopGeneration: number): void {
    const error = this.getCreationCancellationError(sessionId, stopGeneration);
    if (error) {
      throw error;
    }
  }

  private clearStopGenerationIfIdle(sessionId: string): void {
    if (!(this.creationLocks.has(sessionId) || this.stopOperations.has(sessionId))) {
      this.stopGenerations.delete(sessionId);
    }
  }

  private createShutdownSignal(sessionId: string): AcpStartupSignal {
    let rejectShutdown!: () => void;
    const promise = new Promise<never>((_resolve, reject) => {
      rejectShutdown = () => reject(this.createShutdownError(sessionId));
    });
    void promise.catch(() => undefined);
    if (this.isShuttingDown) {
      rejectShutdown();
    } else {
      this.shutdownWaiters.add(rejectShutdown);
    }
    return {
      promise,
      dispose: () => this.shutdownWaiters.delete(rejectShutdown),
    };
  }

  private createSessionStopSignal(sessionId: string): AcpStartupSignal {
    let rejectStop!: () => void;
    const promise = new Promise<never>((_resolve, reject) => {
      rejectStop = () => reject(this.createStopRequestedError(sessionId));
    });
    void promise.catch(() => undefined);
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
        waiters?.delete(rejectStop);
        if (waiters?.size === 0) {
          this.sessionStopWaiters.delete(sessionId);
        }
      },
    };
  }

  private beginSessionStop(sessionId: string): void {
    this.stoppingInProgress.add(sessionId);
    const waiters = this.sessionStopWaiters.get(sessionId);
    if (!waiters) {
      return;
    }
    for (const rejectStop of waiters) {
      rejectStop();
    }
    this.sessionStopWaiters.delete(sessionId);
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
    this.onClientCreatedCallback?.(sessionId, handle, context);
    if (!handlers.onSessionId) {
      return;
    }
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

  private async stopClientOnce(sessionId: string): Promise<void> {
    this.stopGenerations.set(sessionId, this.getStopGeneration(sessionId) + 1);
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
          STOP_TIMEOUT_MS
        );
      }
      const handle = this.sessions.get(sessionId);
      if (!handle) {
        return;
      }
      stoppedHandle = handle;
      this.managedStopChildren.add(handle.child);
      if (handle.isPromptInFlight) {
        try {
          await this.cancelPrompt(sessionId, handle);
        } catch (error) {
          logger.debug('Failed to cancel prompt during stop (expected)', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const exitPromise = new Promise<void>((resolve) => {
        handle.child.on('exit', () => resolve());
        if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
          resolve();
        }
      });
      handle.child.kill('SIGTERM');
      await raceWithSoftTimeout(exitPromise, STOP_TIMEOUT_MS);
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        logger.warn('ACP process did not exit after SIGTERM, escalating to SIGKILL', {
          sessionId,
          pid: handle.getPid(),
        });
        handle.child.kill('SIGKILL');
      }
    } finally {
      this.stoppingInProgress.delete(sessionId);
      if (this.sessions.get(sessionId) === stoppedHandle) {
        this.sessions.delete(sessionId);
        this.browseOnlySessions.delete(sessionId);
      }
    }
  }

  private async stopCurrentClients(timeoutMs: number): Promise<unknown[]> {
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((sessionId) =>
        raceWithSoftTimeout(this.stopClient(sessionId), timeoutMs)
      )
    );
    return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  }

  private async captureShutdownFailure(
    failures: unknown[],
    operation: () => Promise<void>
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
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

  private clearRegistries(): void {
    this.sessions.clear();
    this.browseOnlySessions.clear();
    this.pendingCreation.clear();
    this.stoppingInProgress.clear();
    this.stopOperations.clear();
    this.exitHandling.clear();
    this.creationLocks.clear();
    this.lockRefCounts.clear();
    this.stopGenerations.clear();
    this.shutdownWaiters.clear();
    this.sessionStopWaiters.clear();
  }
}
