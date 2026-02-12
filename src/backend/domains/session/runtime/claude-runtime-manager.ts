import pLimit from 'p-limit';
import { ClaudeClient, type ClaudeClientOptions } from '@/backend/domains/session/claude/client';
import type { ResourceUsage } from '@/backend/domains/session/claude/process';
import { processRegistry, type RegisteredProcess } from '@/backend/domains/session/claude/registry';
import { createLogger } from '@/backend/services/logger.service';
import type {
  ProviderRuntimeManager,
  RuntimeCreatedCallback,
  RuntimeEventHandlers,
} from './provider-runtime-manager';

const logger = createLogger('claude-runtime-manager');

export type ClaudeRuntimeCreatedCallback = RuntimeCreatedCallback<ClaudeClient>;
export type ClaudeRuntimeEventHandlers = RuntimeEventHandlers;

export class ClaudeRuntimeManager
  implements ProviderRuntimeManager<ClaudeClient, ClaudeClientOptions>
{
  private readonly clients = new Map<string, ClaudeClient>();
  private readonly pendingCreation = new Map<string, Promise<ClaudeClient>>();
  private readonly stoppingInProgress = new Set<string>();
  private readonly creationLocks = new Map<string, ReturnType<typeof pLimit>>();
  private readonly lockRefCounts = new Map<string, number>();
  private onClientCreatedCallback: ClaudeRuntimeCreatedCallback | null = null;

  setOnClientCreated(callback: ClaudeRuntimeCreatedCallback): void {
    this.onClientCreatedCallback = callback;
  }

  isStopInProgress(sessionId: string): boolean {
    return this.stoppingInProgress.has(sessionId);
  }

  getOrCreateClient(
    sessionId: string,
    options: ClaudeClientOptions,
    handlers: ClaudeRuntimeEventHandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<ClaudeClient> {
    let lock = this.creationLocks.get(sessionId);
    if (!lock) {
      lock = pLimit(1);
      this.creationLocks.set(sessionId, lock);
      this.lockRefCounts.set(sessionId, 0);
    }

    const currentCount = this.lockRefCounts.get(sessionId) ?? 0;
    this.lockRefCounts.set(sessionId, currentCount + 1);

    return lock(async () => {
      try {
        const existing = this.clients.get(sessionId);
        if (existing?.isRunning()) {
          logger.debug('Returning existing running client', { sessionId });
          return existing;
        }

        const pending = this.pendingCreation.get(sessionId);
        if (pending) {
          logger.debug('Waiting for pending client creation', { sessionId });
          return await pending;
        }

        logger.info('Creating new ClaudeClient', { sessionId, options });
        const createPromise = this.createClient(sessionId, options, handlers, context);
        this.pendingCreation.set(sessionId, createPromise);

        try {
          return await createPromise;
        } finally {
          this.pendingCreation.delete(sessionId);
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

  getClient(sessionId: string): ClaudeClient | undefined {
    const client = this.clients.get(sessionId);
    return client?.isRunning() ? client : undefined;
  }

  getPendingClient(sessionId: string): Promise<ClaudeClient> | undefined {
    return this.pendingCreation.get(sessionId);
  }

  async createClient(
    sessionId: string,
    options: ClaudeClientOptions,
    handlers: ClaudeRuntimeEventHandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<ClaudeClient> {
    const client = await ClaudeClient.create(options);
    this.clients.set(sessionId, client);

    this.attachClientHandlers(sessionId, client, handlers);

    if (this.onClientCreatedCallback) {
      this.onClientCreatedCallback(sessionId, client, context);
    }

    logger.info('ClaudeClient created', {
      sessionId,
      pid: client.getPid(),
      model: options.model,
    });

    return client;
  }

  async stopClient(sessionId: string): Promise<void> {
    if (this.stoppingInProgress.has(sessionId)) {
      logger.debug('Session stop already in progress', { sessionId });
      return;
    }

    const client = this.clients.get(sessionId);
    if (!client) {
      return;
    }

    this.stoppingInProgress.add(sessionId);
    try {
      await client.stop();
    } catch (error) {
      logger.warn('Failed to stop client gracefully, forcing kill', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      client.kill();
    } finally {
      this.stoppingInProgress.delete(sessionId);
      this.clients.delete(sessionId);
    }
  }

  getAllClients(): IterableIterator<[string, ClaudeClient]> {
    return this.clients.entries();
  }

  async stopAllClients(timeoutMs = 5000): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    for (const [sessionId, client] of this.clients) {
      let didTimeout = false;
      const stopPromise = Promise.race([
        (async () => {
          try {
            await client.stop();
          } catch {
            client.kill();
          }
        })(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            didTimeout = true;
            resolve();
          }, timeoutMs)
        ),
      ]).then(() => {
        if (didTimeout) {
          logger.warn('Client stop timed out, force killing', { sessionId });
        }
        try {
          client.kill();
        } catch {
          // Ignore kill errors
        }
      });

      stopPromises.push(stopPromise);
      logger.debug('Stopping chat client', { sessionId });
    }

    await Promise.all(stopPromises);

    for (const client of this.clients.values()) {
      client.removeAllListeners();
    }
    this.clients.clear();
    this.creationLocks.clear();
    this.lockRefCounts.clear();

    logger.info('All clients stopped and cleaned up');
  }

  getClaudeProcess(sessionId: string): RegisteredProcess | undefined {
    return processRegistry.get(sessionId);
  }

  isSessionRunning(sessionId: string): boolean {
    const process = processRegistry.get(sessionId);
    return process?.isRunning() ?? false;
  }

  isSessionWorking(sessionId: string): boolean {
    return processRegistry.isProcessWorking(sessionId);
  }

  isAnySessionWorking(sessionIds: string[]): boolean {
    return processRegistry.isAnyProcessWorking(sessionIds);
  }

  getAllActiveProcesses(): Array<{
    sessionId: string;
    pid: number | undefined;
    status: string;
    isRunning: boolean;
    resourceUsage: ResourceUsage | null;
    idleTimeMs: number;
  }> {
    const processes: Array<{
      sessionId: string;
      pid: number | undefined;
      status: string;
      isRunning: boolean;
      resourceUsage: ResourceUsage | null;
      idleTimeMs: number;
    }> = [];

    for (const [sessionId, process] of processRegistry.getAll()) {
      processes.push({
        sessionId,
        pid: process.getPid(),
        status: process.getStatus(),
        isRunning: process.isRunning(),
        resourceUsage: process.getResourceUsage(),
        idleTimeMs: process.getIdleTimeMs(),
      });
    }

    return processes;
  }

  private attachClientHandlers(
    sessionId: string,
    client: ClaudeClient,
    handlers: ClaudeRuntimeEventHandlers
  ): void {
    client.on('session_id', async (claudeSessionId) => {
      if (!handlers.onSessionId) {
        return;
      }
      try {
        await handlers.onSessionId(sessionId, claudeSessionId);
      } catch (error) {
        logger.warn('Failed to handle session_id event', {
          sessionId,
          claudeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    client.on('exit', async (result) => {
      this.clients.delete(sessionId);
      this.pendingCreation.delete(sessionId);

      if (this.stoppingInProgress.has(sessionId)) {
        logger.debug('Skipping exit handler status update - stop in progress', { sessionId });
        return;
      }

      if (!handlers.onExit) {
        return;
      }

      try {
        await handlers.onExit(sessionId, result.code);
      } catch (error) {
        logger.warn('Failed to handle exit event', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    client.on('error', async (error) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      if (!handlers.onError) {
        logger.warn('Claude client error (no handler provided)', {
          sessionId,
          error: normalizedError.message,
        });
        return;
      }

      try {
        await handlers.onError(sessionId, normalizedError);
      } catch (handlerError) {
        logger.warn('Failed to handle error event', {
          sessionId,
          originalError: normalizedError.message,
          handlerError: handlerError instanceof Error ? handlerError.message : String(handlerError),
        });
      }
    });
  }
}

export const claudeRuntimeManager = new ClaudeRuntimeManager();
