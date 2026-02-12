import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { CodexSessionRegistry } from '@/backend/domains/session/codex/codex-session-registry';
import {
  CodexManagerUnavailableError,
  SessionOperationError,
} from '@/backend/domains/session/codex/errors';
import { asRecord, parseThreadId } from '@/backend/domains/session/codex/payload-utils';
import type {
  CodexManagerHandlers,
  CodexManagerServerRequestEvent,
  CodexManagerStatus,
  CodexProcessFactory,
  CodexRequestId,
  CodexRequestOptions,
  CodexTransportError,
  CodexTransportRequest,
  CodexTransportResponse,
  CodexUnavailableReason,
} from '@/backend/domains/session/codex/types';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('codex-app-server-manager');

interface PendingRequest {
  method: string;
  threadId?: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const TransportEnvelopeSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

function isResponse(message: unknown): message is CodexTransportResponse {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  return (
    Object.hasOwn(message, 'id') &&
    (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
  );
}

function isServerRequest(message: unknown): message is CodexTransportRequest {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  return Object.hasOwn(message, 'id') && Object.hasOwn(message, 'method') && !isResponse(message);
}

function parseError(error: unknown): CodexTransportError {
  if (typeof error !== 'object' || error === null) {
    return { code: -1, message: String(error) };
  }

  const typed = error as { code?: unknown; message?: unknown; data?: unknown };
  return {
    code: typeof typed.code === 'number' ? typed.code : -1,
    message: typeof typed.message === 'string' ? typed.message : 'Unknown Codex app-server error',
    ...(Object.hasOwn(typed, 'data') ? { data: typed.data } : {}),
  };
}

function getCanonicalRequestId(serverRequestId: CodexRequestId, params: unknown): string {
  const record = asRecord(params);
  if (typeof record.requestId === 'string' && record.requestId.length > 0) {
    return record.requestId;
  }
  if (typeof record.itemId === 'string' && record.itemId.length > 0) {
    return record.itemId;
  }
  const item = asRecord(record.item);
  if (typeof item.id === 'string' && item.id.length > 0) {
    return item.id;
  }

  return `codex-request-${String(serverRequestId)}`;
}

const DEFAULT_PROCESS_FACTORY: CodexProcessFactory = {
  spawn(command, args) {
    return spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  },
};

export class CodexAppServerManager {
  private readonly registry: CodexSessionRegistry;
  private readonly processFactory: CodexProcessFactory;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers: CodexManagerHandlers;

  private process: ReturnType<CodexProcessFactory['spawn']> | null = null;
  private startPromise: Promise<void> | null = null;
  private requestId = 1;
  private state: CodexManagerStatus['state'] = 'stopped';
  private unavailableReason: CodexUnavailableReason | null = null;
  private startedAt: string | null = null;
  private restartCount = 0;

  constructor(options?: {
    registry?: CodexSessionRegistry;
    processFactory?: CodexProcessFactory;
    handlers?: CodexManagerHandlers;
  }) {
    this.registry = options?.registry ?? new CodexSessionRegistry();
    this.processFactory = options?.processFactory ?? DEFAULT_PROCESS_FACTORY;
    this.handlers = options?.handlers ?? {};
  }

  setHandlers(handlers: CodexManagerHandlers): void {
    this.handlers.onNotification = handlers.onNotification;
    this.handlers.onServerRequest = handlers.onServerRequest;
    this.handlers.onStatusChanged = handlers.onStatusChanged;
    this.handlers.onSessionDelta = handlers.onSessionDelta;
  }

  getRegistry(): CodexSessionRegistry {
    return this.registry;
  }

  getStatus(): CodexManagerStatus {
    return {
      state: this.state,
      unavailableReason: this.unavailableReason,
      pid: this.process?.pid ?? null,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      activeSessionCount: this.registry.getActiveSessionCount(),
    };
  }

  async ensureStarted(): Promise<void> {
    if (this.state === 'ready' && this.process) {
      return;
    }

    if (!process.env.OPENAI_API_KEY) {
      this.markUnavailable('missing_api_key');
      throw new CodexManagerUnavailableError('missing_api_key');
    }

    if (this.startPromise !== null) {
      await this.startPromise;
      return;
    }

    this.state = 'starting';
    this.emitStatus();

    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async request(method: string, params?: unknown, options?: CodexRequestOptions): Promise<unknown> {
    await this.ensureStarted();
    return await this.requestWithoutEnsureStarted(method, params, options);
  }

  private async requestWithoutEnsureStarted(
    method: string,
    params?: unknown,
    options?: CodexRequestOptions
  ): Promise<unknown> {
    if (!this.process) {
      throw new CodexManagerUnavailableError('spawn_failed');
    }

    const id = this.requestId++;
    const timeoutMs =
      options?.timeoutMs ?? configService.getCodexAppServerConfig().requestTimeoutMs;

    const payload: CodexTransportRequest = {
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new SessionOperationError(`Codex request timed out: ${method}`, {
            code: 'CODEX_REQUEST_TIMEOUT',
            metadata: {
              method,
              requestId: id,
              ...(options?.threadId ? { threadId: options.threadId } : {}),
            },
            retryable: true,
          })
        );
      }, timeoutMs);

      this.pending.set(id, {
        method,
        threadId: options?.threadId,
        resolve,
        reject,
        timeout,
      });

      try {
        this.write(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(
          error instanceof Error
            ? error
            : new SessionOperationError('Failed to write Codex request', {
                code: 'CODEX_REQUEST_FAILED',
                metadata: {
                  method,
                  requestId: id,
                  ...(options?.threadId ? { threadId: options.threadId } : {}),
                },
                retryable: true,
              })
        );
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const payload = {
      method,
      ...(params === undefined ? {} : { params }),
    };
    this.write(payload);
  }

  respond(serverRequestId: CodexRequestId, result: unknown, isError = false): void {
    if (!this.process?.stdin.writable) {
      throw new CodexManagerUnavailableError('process_exited');
    }

    this.write({
      id: serverRequestId,
      ...(isError ? { error: result } : { result }),
    });
  }

  stop(): Promise<void> {
    const processToStop = this.process;
    if (!processToStop) {
      this.state = 'stopped';
      this.unavailableReason = null;
      this.startedAt = null;
      this.emitStatus();
      return Promise.resolve();
    }

    this.process = null;
    this.state = 'stopped';
    this.unavailableReason = null;
    this.startedAt = null;
    this.rejectAllPending('Codex app-server stopped');
    this.emitStatus();

    try {
      processToStop.kill('SIGTERM');
    } catch {
      // ignore shutdown errors
    }
    return Promise.resolve();
  }

  private async startProcess(): Promise<void> {
    const processConfig = configService.getCodexAppServerConfig();

    let child: ReturnType<CodexProcessFactory['spawn']>;
    try {
      child = this.processFactory.spawn(processConfig.command, processConfig.args);
    } catch (error) {
      this.markUnavailable('spawn_failed');
      throw new CodexManagerUnavailableError(
        `spawn_failed:${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.process = child;
    this.startedAt = new Date().toISOString();

    const stdoutReader = createInterface({ input: child.stdout });
    stdoutReader.on('line', (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        const parsed = TransportEnvelopeSchema.parse(JSON.parse(line));
        this.handleInbound(parsed);
      } catch (error) {
        logger.warn('Failed to parse Codex app-server line', {
          line,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    child.stderr.on('data', (chunk) => {
      logger.debug('Codex app-server stderr', { stderr: chunk.toString() });
    });

    child.on('error', (error) => {
      if (this.process !== child) {
        logger.debug('Ignoring stale Codex app-server error event', {
          error: error.message,
        });
        return;
      }
      logger.error('Codex app-server process error', {
        error: error.message,
      });
      this.markUnavailable('spawn_failed');
    });

    child.on('exit', (code, signal) => {
      if (this.process !== child) {
        logger.debug('Ignoring stale Codex app-server exit event', { code, signal });
        return;
      }
      logger.warn('Codex app-server exited', { code, signal });
      this.process = null;
      if (this.state === 'stopped' || this.state === 'unavailable') {
        return;
      }
      this.state = 'degraded';
      this.unavailableReason = 'process_exited';
      this.restartCount += 1;
      this.rejectAllPending('Codex app-server exited');
      this.emitStatus();
    });

    try {
      await this.requestWithoutEnsureStarted(
        'initialize',
        {
          clientInfo: {
            name: 'factory-factory',
            title: null,
            version: configService.getAppVersion(),
          },
          capabilities: null,
        },
        {
          timeoutMs: processConfig.handshakeTimeoutMs,
        }
      );
      this.notify('initialized');
    } catch (error) {
      this.markUnavailable('handshake_failed');
      throw new CodexManagerUnavailableError(
        `handshake_failed:${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.state = 'ready';
    this.unavailableReason = null;
    this.emitStatus();
  }

  private write(payload: unknown): void {
    if (!this.process?.stdin.writable) {
      throw new CodexManagerUnavailableError('process_exited');
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleInbound(message: unknown): void {
    const record = asRecord(message);
    if (isResponse(record)) {
      this.handleResponse(record);
      return;
    }

    if (isServerRequest(record)) {
      this.handleServerRequest(record);
      return;
    }

    const threadId = parseThreadId(record.params);
    if (!threadId) {
      logger.debug('Dropping Codex notification without threadId', {
        method: record.method,
      });
      return;
    }

    const sessionId = this.registry.getSessionIdByThreadId(threadId);
    if (!sessionId) {
      logger.warn('Dropping unroutable Codex notification', {
        method: record.method,
        threadId,
      });
      return;
    }

    this.handlers.onNotification?.({
      sessionId,
      threadId,
      method: typeof record.method === 'string' ? record.method : 'unknown',
      params: record.params,
    });
  }

  private handleResponse(message: CodexTransportResponse): void {
    if (typeof message.id !== 'number') {
      logger.warn('Received response with non-numeric request id', {
        requestId: message.id,
      });
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      logger.warn('Received response for unknown Codex request id', {
        requestId: message.id,
      });
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(
        new SessionOperationError(`Codex request failed: ${pending.method}`, {
          code: 'CODEX_REQUEST_FAILED',
          metadata: {
            method: pending.method,
            requestId: message.id,
            error: parseError(message.error),
            ...(pending.threadId ? { threadId: pending.threadId } : {}),
          },
        })
      );
      return;
    }

    pending.resolve(message.result);
  }

  private handleServerRequest(message: CodexTransportRequest): void {
    const threadId = parseThreadId(message.params);
    if (!threadId) {
      logger.warn('Dropping Codex server request without threadId', {
        requestId: message.id,
        method: message.method,
      });
      this.rejectServerRequest(message, {
        code: -32_602,
        message: 'Codex server request missing threadId',
        data: {
          method: message.method,
        },
      });
      return;
    }

    const sessionId = this.registry.getSessionIdByThreadId(threadId);
    if (!sessionId) {
      logger.warn('Dropping unroutable Codex server request', {
        requestId: message.id,
        method: message.method,
        threadId,
      });
      this.rejectServerRequest(message, {
        code: -32_602,
        message: `No active session mapped for threadId: ${threadId}`,
        data: {
          method: message.method,
          threadId,
        },
      });
      return;
    }

    const requestId = getCanonicalRequestId(message.id, message.params);
    this.registry.addPendingInteractiveRequest({
      sessionId,
      threadId,
      requestId,
      serverRequestId: message.id,
      method: message.method,
      params: asRecord(message.params),
    });

    const requestEvent: CodexManagerServerRequestEvent = {
      sessionId,
      threadId,
      method: message.method,
      params: message.params,
      requestId: message.id,
      canonicalRequestId: requestId,
    };
    this.handlers.onServerRequest?.(requestEvent);
  }

  private rejectServerRequest(
    message: CodexTransportRequest,
    error: { code: number; message: string; data?: unknown }
  ): void {
    try {
      this.respond(message.id, error, true);
    } catch (responseError) {
      logger.warn('Failed to respond to dropped Codex server request', {
        requestId: message.id,
        method: message.method,
        error: responseError instanceof Error ? responseError.message : String(responseError),
      });
    }
  }

  private markUnavailable(reason: CodexUnavailableReason): void {
    const processToStop = this.process;
    this.state = 'unavailable';
    this.unavailableReason = reason;
    this.process = null;
    this.startedAt = null;

    if (processToStop) {
      try {
        processToStop.kill('SIGTERM');
      } catch {
        // ignore shutdown errors
      }
    }

    this.rejectAllPending(`Codex app-server unavailable: ${reason}`);
    this.emitStatus();
  }

  private rejectAllPending(reason: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new SessionOperationError(reason, {
          code: 'CODEX_MANAGER_UNAVAILABLE',
          metadata: {
            requestId,
            method: pending.method,
            ...(pending.threadId ? { threadId: pending.threadId } : {}),
          },
          retryable: true,
        })
      );
      this.pending.delete(requestId);
    }
  }

  private emitStatus(): void {
    this.handlers.onStatusChanged?.(this.getStatus());
  }
}

export const codexAppServerManager = new CodexAppServerManager();
