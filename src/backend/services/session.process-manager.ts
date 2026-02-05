import { ClaudeClient, type ClaudeClientOptions } from '../claude/index';
import type { ResourceUsage } from '../claude/process';
import {
  getAllProcesses,
  getProcess,
  isAnyProcessWorking,
  isProcessWorking,
  type RegisteredProcess,
} from '../claude/registry';
import { createLogger } from './logger.service';

const logger = createLogger('session-process');

export type ClientCreatedCallback = (
  sessionId: string,
  client: ClaudeClient,
  context: { workspaceId: string; workingDir: string }
) => void;

export type ClientEventHandlers = {
  onSessionId?: (sessionId: string, claudeSessionId: string) => Promise<void>;
  onExit?: (sessionId: string) => Promise<void>;
  onError?: (sessionId: string, error: Error) => Promise<void>;
};

export class SessionProcessManager {
  private readonly clients = new Map<string, ClaudeClient>();
  private readonly pendingCreation = new Map<string, Promise<ClaudeClient>>();
  private readonly stoppingInProgress = new Set<string>();
  private onClientCreatedCallback: ClientCreatedCallback | null = null;

  setOnClientCreated(callback: ClientCreatedCallback): void {
    this.onClientCreatedCallback = callback;
  }

  isStopInProgress(sessionId: string): boolean {
    return this.stoppingInProgress.has(sessionId);
  }

  async getOrCreateClient(
    sessionId: string,
    options: ClaudeClientOptions,
    handlers: ClientEventHandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<ClaudeClient> {
    const existing = this.clients.get(sessionId);
    if (existing?.isRunning()) {
      logger.debug('Returning existing running client', { sessionId });
      return existing;
    }

    const pending = this.pendingCreation.get(sessionId);
    if (pending) {
      logger.debug('Waiting for pending client creation', { sessionId });
      return pending;
    }

    logger.info('Creating new ClaudeClient', { sessionId, options });
    const createPromise = this.createClient(sessionId, options, handlers, context);
    this.pendingCreation.set(sessionId, createPromise);

    try {
      return await createPromise;
    } finally {
      this.pendingCreation.delete(sessionId);
    }
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
    handlers: ClientEventHandlers,
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

    logger.info('All clients stopped and cleaned up');
  }

  getClaudeProcess(sessionId: string): RegisteredProcess | undefined {
    return getProcess(sessionId);
  }

  isSessionRunning(sessionId: string): boolean {
    const process = getProcess(sessionId);
    return process?.isRunning() ?? false;
  }

  isSessionWorking(sessionId: string): boolean {
    return isProcessWorking(sessionId);
  }

  isAnySessionWorking(sessionIds: string[]): boolean {
    return isAnyProcessWorking(sessionIds);
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

    for (const [sessionId, process] of getAllProcesses()) {
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
    handlers: ClientEventHandlers
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

    client.on('exit', async () => {
      this.clients.delete(sessionId);

      if (this.stoppingInProgress.has(sessionId)) {
        logger.debug('Skipping exit handler status update - stop in progress', { sessionId });
        return;
      }

      if (!handlers.onExit) {
        return;
      }

      try {
        await handlers.onExit(sessionId);
      } catch (error) {
        logger.warn('Failed to handle exit event', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    client.on('error', async (error) => {
      if (!handlers.onError) {
        logger.warn('Claude client error (no handler provided)', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      try {
        await handlers.onError(sessionId, error);
      } catch (handlerError) {
        logger.warn('Failed to handle error event', {
          sessionId,
          originalError: error instanceof Error ? error.message : String(error),
          handlerError: handlerError instanceof Error ? handlerError.message : String(handlerError),
        });
      }
    });
  }
}

export const sessionProcessManager = new SessionProcessManager();
