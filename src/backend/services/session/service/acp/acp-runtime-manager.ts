import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  type ContentBlock,
  type LoadSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import pLimit from 'p-limit';
import { createLogger, getCurrentProcessEnv } from '@/backend/services/logger.service';
import { AcpClientHandler, type AutoApprovePolicy } from './acp-client-handler';
import type { AcpPermissionBridge } from './acp-permission-bridge';
import { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimeEvent } from './acp-runtime-events';
import {
  createAcpSpawnError,
  hasUsableWorkingDir,
  resolveAcpBinary,
  resolveInternalCodexAcpSpawnCommand,
  type SpawnCommand,
  withTimeout,
} from './acp-runtime-spawn';
import { requireSessionConfigOptions } from './acp-session-config-options';
import { createNormalizedAcpReadableStream, normalizeUnknownError } from './acp-stream-normalizer';
import type { AcpClientOptions, PermissionPreset } from './types';

const logger = createLogger('acp-runtime-manager');

/** Thrown when an ACP prompt exceeds the caller-specified timeout. */
export class PromptTimeoutError extends Error {
  constructor(sessionId: string, timeoutMs: number) {
    super(`ACP prompt timed out after ${timeoutMs}ms for session ${sessionId}`);
    this.name = 'PromptTimeoutError';
  }
}

export type AcpRuntimeCreatedCallback = (
  sessionId: string,
  client: AcpProcessHandle,
  context: { workspaceId: string; workingDir: string }
) => void;

export type AcpRuntimeEventHandlers = {
  onSessionId?: (sessionId: string, providerSessionId: string) => Promise<void>;
  onExit?: (sessionId: string, code: number | null) => Promise<void>;
  onError?: (sessionId: string, error: Error) => Promise<void> | void;
  onAcpEvent?: (sessionId: string, event: AcpRuntimeEvent) => void;
  onAcpLog?: (sessionId: string, payload: Record<string, unknown>) => void;
  /** Permission bridge to inject into AcpClientHandler for suspending requestPermission */
  permissionBridge?: AcpPermissionBridge;
};

function resolveAutoApprovePolicy(preset: PermissionPreset | undefined): AutoApprovePolicy {
  if (preset === 'YOLO' || preset === 'RELAXED') {
    return 'all';
  }
  return 'none';
}

const DEFAULT_ACP_STARTUP_TIMEOUT_MS = 30_000;

type AcpErrorLogDetails = {
  message: string;
  code?: number | string;
  data?: unknown;
};

function getAcpErrorLogDetails(error: unknown): AcpErrorLogDetails {
  if (error instanceof Error) {
    return { message: error.message };
  }

  if (typeof error === 'object' && error !== null) {
    const maybe = error as { message?: unknown; code?: unknown; data?: unknown };
    const message =
      typeof maybe.message === 'string'
        ? maybe.message
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
    const code =
      typeof maybe.code === 'number' || typeof maybe.code === 'string' ? maybe.code : undefined;
    return {
      message,
      ...(code !== undefined ? { code } : {}),
      ...(typeof maybe.data !== 'undefined' ? { data: maybe.data } : {}),
    };
  }

  return { message: String(error) };
}

function isMethodNotFoundError(error: unknown): boolean {
  const details = getAcpErrorLogDetails(error);
  return details.code === -32_601 || details.message.includes('Method not found');
}

async function raceWithSoftTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export class AcpRuntimeManager {
  private readonly sessions = new Map<string, AcpProcessHandle>();
  private readonly pendingCreation = new Map<string, Promise<AcpProcessHandle>>();
  private readonly stoppingInProgress = new Set<string>();
  private readonly managedStopChildren = new WeakSet<ChildProcess>();
  private readonly creationLocks = new Map<string, ReturnType<typeof pLimit>>();
  private readonly lockRefCounts = new Map<string, number>();
  private readonly shutdownWaiters = new Set<() => void>();
  private readonly sessionStopWaiters = new Map<string, Set<() => void>>();
  private isShuttingDown = false;
  private onClientCreatedCallback: AcpRuntimeCreatedCallback | null = null;
  private acpStartupTimeoutMs = DEFAULT_ACP_STARTUP_TIMEOUT_MS;
  private preferSourceEntrypoint = true;
  private childProcessEnvProvider: () => NodeJS.ProcessEnv = getCurrentProcessEnv;

  constructor(options?: { acpStartupTimeoutMs?: number }) {
    this.setAcpStartupTimeoutMs(options?.acpStartupTimeoutMs ?? DEFAULT_ACP_STARTUP_TIMEOUT_MS);
  }

  setAcpStartupTimeoutMs(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      this.acpStartupTimeoutMs = DEFAULT_ACP_STARTUP_TIMEOUT_MS;
      return;
    }
    this.acpStartupTimeoutMs = Math.floor(timeoutMs);
  }

  configureEnvironment(options: {
    preferSourceEntrypoint: boolean;
    childProcessEnvProvider: () => NodeJS.ProcessEnv;
  }): void {
    this.preferSourceEntrypoint = options.preferSourceEntrypoint;
    this.childProcessEnvProvider = options.childProcessEnvProvider;
  }

  setOnClientCreated(callback: AcpRuntimeCreatedCallback): void {
    this.onClientCreatedCallback = callback;
  }

  isStopInProgress(sessionId: string): boolean {
    return this.stoppingInProgress.has(sessionId);
  }

  getClient(sessionId: string): AcpProcessHandle | undefined {
    const handle = this.sessions.get(sessionId);
    return handle?.isRunning() ? handle : undefined;
  }

  getPendingClient(sessionId: string): Promise<AcpProcessHandle> | undefined {
    return this.pendingCreation.get(sessionId);
  }

  getOrCreateClient(
    sessionId: string,
    options: AcpClientOptions,
    handlers: AcpRuntimeEventHandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<AcpProcessHandle> {
    if (this.isShuttingDown) {
      return Promise.reject(this.createShutdownError(sessionId));
    }

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
        if (this.isShuttingDown) {
          throw this.createShutdownError(sessionId);
        }

        const existing = this.sessions.get(sessionId);
        if (existing?.isRunning()) {
          logger.debug('Returning existing running ACP client', { sessionId });
          return existing;
        }

        const pending = this.pendingCreation.get(sessionId);
        if (pending) {
          logger.debug('Waiting for pending ACP client creation', { sessionId });
          return await pending;
        }

        logger.info('Creating new ACP client', { sessionId, provider: options.provider });
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

  private async createClient(
    sessionId: string,
    options: AcpClientOptions,
    handlers: AcpRuntimeEventHandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<AcpProcessHandle> {
    if (this.isShuttingDown) {
      throw this.createShutdownError(sessionId);
    }

    if (!hasUsableWorkingDir(options.workingDir)) {
      throw new Error('ACP working directory is required before spawning adapter process');
    }

    const isCodex = options.provider === 'CODEX';
    const spawnCommand: SpawnCommand = options.adapterBinaryPath
      ? {
          command: options.adapterBinaryPath,
          args: [],
          commandLabel: options.adapterBinaryPath,
        }
      : isCodex
        ? resolveInternalCodexAcpSpawnCommand(this.preferSourceEntrypoint)
        : (() => {
            const binaryName = 'claude-agent-acp';
            const packageName = '@agentclientprotocol/claude-agent-acp';
            const binaryPath = resolveAcpBinary(packageName, binaryName);
            return {
              command: binaryPath,
              args: [],
              commandLabel: binaryPath,
            };
          })();

    logger.info('Spawning ACP subprocess', {
      sessionId,
      command: spawnCommand.command,
      args: spawnCommand.args,
      provider: options.provider,
      workingDir: options.workingDir,
    });

    const spawnEnv = {
      ...this.childProcessEnvProvider(),
      BROWSER: 'none',
      ...(isCodex ? { DOTENV_CONFIG_QUIET: 'true' } : {}),
    };

    // Spawn subprocess (CRITICAL: detached MUST be false for orphan prevention)
    const child: ChildProcess = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: options.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      detached: false,
    });

    // Capture startup spawn errors immediately (e.g. ENOENT) so they reject
    // client creation cleanly instead of surfacing as uncaught process errors.
    let startupErrorListener: ((error: unknown) => void) | null = null;
    const startupError = new Promise<never>((_, reject) => {
      startupErrorListener = (error: unknown) =>
        reject(createAcpSpawnError(spawnCommand.commandLabel, error));
      child.once('error', startupErrorListener);
    });
    const startupErrorSettled = startupError.catch(() => undefined);

    this.wireChildErrorHandler(child, sessionId, handlers);
    this.abortClientCreationIfStopping(child, sessionId);

    // Wire stderr to session log hook
    child.stderr?.on('data', (chunk: Buffer) => {
      handlers.onAcpLog?.(options.sessionId, {
        eventType: 'acp_stderr',
        data: chunk.toString(),
      });
    });

    // Convert Node.js streams to Web Streams for ndJsonStream
    // stdout/stdin are guaranteed to be set because we spawned with stdio: ['pipe', 'pipe', 'pipe']
    if (!(child.stdout && child.stdin)) {
      throw new Error('ACP subprocess stdio streams not available');
    }
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);

    // Normalize malformed session/update notifications before SDK Zod validation.
    // Workaround: claude-agent-acp sends `line: [start, end]` arrays instead of numbers.
    const normalizedStream = {
      writable: stream.writable,
      readable: createNormalizedAcpReadableStream(stream.readable),
    };

    // Create event callback that routes to handlers
    const acpEventHandler = handlers.onAcpEvent;
    const onEvent = acpEventHandler
      ? (sid: string, event: AcpRuntimeEvent) => acpEventHandler(sid, event)
      : (_sid: string, _event: AcpRuntimeEvent) => {
          logger.debug('ACP event received but no handler registered', { sessionId });
        };

    // Resolve auto-approve policy from user's configured permission preset
    const autoApprovePolicy = resolveAutoApprovePolicy(options.permissionPreset);

    // Create connection with client handler (inject permission bridge from handlers)
    const connection = new ClientSideConnection(
      (_agent) =>
        new AcpClientHandler(
          sessionId,
          onEvent,
          handlers.permissionBridge,
          handlers.onAcpLog,
          autoApprovePolicy
        ),
      normalizedStream
    );

    let initResult: Awaited<ReturnType<ClientSideConnection['initialize']>>;
    let sessionInfo: Awaited<ReturnType<AcpRuntimeManager['createOrResumeSession']>>;
    const startupTimeoutMs = this.acpStartupTimeoutMs;
    const shutdownSignal = this.createShutdownSignal(sessionId);
    const stopSignal = this.createSessionStopSignal(sessionId);
    const startupCancelOn = Promise.race([
      startupErrorSettled,
      shutdownSignal.promise.catch(() => undefined),
      stopSignal.promise.catch(() => undefined),
    ]);

    try {
      // Initialize handshake
      initResult = await Promise.race([
        withTimeout({
          promise: connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: {
              name: 'factory-factory',
              title: 'Factory Factory',
              version: '1.2.0',
            },
          }),
          timeoutMs: startupTimeoutMs,
          description: 'initialize handshake',
          cancelOn: startupCancelOn,
        }),
        startupError,
        shutdownSignal.promise,
        stopSignal.promise,
      ]);

      logger.info('ACP connection initialized', {
        sessionId,
        agentCapabilities: initResult.agentCapabilities,
      });

      // Create or resume provider session
      const agentCapabilities = initResult.agentCapabilities ?? {};
      sessionInfo = await Promise.race([
        withTimeout({
          promise: this.createOrResumeSession(connection, sessionId, options, agentCapabilities),
          timeoutMs: startupTimeoutMs,
          description: 'session creation',
          cancelOn: startupCancelOn,
        }),
        startupError,
        shutdownSignal.promise,
        stopSignal.promise,
      ]);
    } catch (error) {
      this.cleanupFailedClientCreation(child, sessionId);
      throw error;
    } finally {
      shutdownSignal.dispose();
      stopSignal.dispose();
      if (startupErrorListener) {
        child.removeListener('error', startupErrorListener);
        startupErrorListener = null;
      }
    }

    if (this.isShuttingDown) {
      this.cleanupFailedClientCreation(child, sessionId);
      throw this.createShutdownError(sessionId);
    }

    this.abortClientCreationIfStopping(child, sessionId);

    // Build handle
    const agentCapabilities = initResult.agentCapabilities ?? {};
    const handle = new AcpProcessHandle({
      connection,
      child,
      provider: options.provider,
      providerSessionId: sessionInfo.providerSessionId,
      agentCapabilities,
    });
    handle.configOptions = sessionInfo.configOptions;

    // Store in sessions map
    this.sessions.set(sessionId, handle);

    this.wireChildExitHandler(sessionId, child, handlers);
    await this.notifyClientCreated(sessionId, handle, context, handlers);

    return handle;
  }

  private cleanupFailedClientCreation(child: ChildProcess, sessionId: string): void {
    if (child.exitCode !== null) {
      return;
    }

    try {
      child.kill('SIGTERM');
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    } catch {
      // Ignore process-kill errors while cleaning up failed initialization.
    }

    logger.warn('Cleaned up ACP subprocess after initialization failure', {
      sessionId,
      pid: child.pid,
    });
  }

  private abortClientCreationIfStopping(child: ChildProcess, sessionId: string): void {
    if (!this.stoppingInProgress.has(sessionId)) {
      return;
    }

    this.cleanupFailedClientCreation(child, sessionId);
    throw this.createStopRequestedError(sessionId);
  }

  private createShutdownError(sessionId: string): Error {
    return new Error(`ACP runtime manager is shutting down; cannot create client ${sessionId}`);
  }

  private createStopRequestedError(sessionId: string): Error {
    return new Error(`ACP session stop requested; cannot create client ${sessionId}`);
  }

  private beginShutdown(): void {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    for (const rejectShutdown of this.shutdownWaiters) {
      rejectShutdown();
    }
    this.shutdownWaiters.clear();
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

  private createShutdownSignal(sessionId: string): {
    promise: Promise<never>;
    dispose: () => void;
  } {
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

  private createSessionStopSignal(sessionId: string): {
    promise: Promise<never>;
    dispose: () => void;
  } {
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
    handlers: AcpRuntimeEventHandlers
  ): void {
    child.on('exit', async (code) => {
      if (this.shouldSkipChildExitHandler(sessionId, child, code)) {
        return;
      }

      this.pendingCreation.delete(sessionId);

      if (handlers.onExit) {
        try {
          await handlers.onExit(sessionId, code);
        } catch (error) {
          logger.warn('Failed to handle ACP exit event', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  }

  private shouldSkipChildExitHandler(
    sessionId: string,
    child: ChildProcess,
    code: number | null
  ): boolean {
    const current = this.sessions.get(sessionId);
    const isCurrentProcess = current?.child === child;
    const isManagedStopProcess = this.managedStopChildren.delete(child);

    if (isCurrentProcess) {
      this.sessions.delete(sessionId);
    }

    if (current && !isCurrentProcess) {
      logger.debug('Skipping exit handler - stale ACP process exited', {
        sessionId,
        code,
        pid: child.pid,
        currentPid: current.getPid(),
      });
      return true;
    }

    if (isManagedStopProcess || this.stoppingInProgress.has(sessionId)) {
      logger.debug('Skipping exit handler - managed stop process exited', { sessionId, code });
      return true;
    }

    return false;
  }

  private async notifyClientCreated(
    sessionId: string,
    handle: AcpProcessHandle,
    context: { workspaceId: string; workingDir: string },
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

  private wireChildErrorHandler(
    child: ChildProcess,
    sessionId: string,
    handlers: AcpRuntimeEventHandlers
  ): void {
    // Route runtime child-process errors through the domain error callback.
    child.on('error', async (error) => {
      const normalizedError = normalizeUnknownError(error);
      if (handlers.onError) {
        try {
          await handlers.onError(sessionId, normalizedError);
        } catch (handlerError) {
          logger.warn('Failed to handle ACP error event', {
            sessionId,
            originalError: normalizedError.message,
            handlerError:
              handlerError instanceof Error ? handlerError.message : String(handlerError),
          });
        }
      } else {
        logger.warn('ACP child process error (no handler provided)', {
          sessionId,
          error: normalizedError.message,
        });
      }
    });
  }

  private async createOrResumeSession(
    connection: ClientSideConnection,
    sessionId: string,
    options: AcpClientOptions,
    agentCapabilities: Record<string, unknown>
  ): Promise<{
    providerSessionId: string;
    configOptions: SessionConfigOption[];
  }> {
    const storedId = options.resumeProviderSessionId;
    const canResume = agentCapabilities.loadSession === true && !!storedId;

    const mcpServers = (options.mcpServers ?? []).map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args,
      env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
    }));
    if (canResume && storedId) {
      let loadResult: LoadSessionResponse | null = null;
      try {
        loadResult = await connection.loadSession({
          sessionId: storedId,
          cwd: options.workingDir,
          mcpServers,
        });
      } catch (error) {
        const details = getAcpErrorLogDetails(error);
        logger.warn('loadSession failed, falling back to newSession', {
          sessionId,
          storedProviderSessionId: storedId,
          error: details.message,
          ...(details.code !== undefined ? { errorCode: details.code } : {}),
          ...(typeof details.data !== 'undefined' ? { errorData: details.data } : {}),
        });
      }

      if (loadResult !== null) {
        logger.info('ACP session resumed via loadSession', {
          sessionId,
          providerSessionId: storedId,
        });

        return {
          providerSessionId: storedId,
          configOptions: requireSessionConfigOptions(options.provider, 'loadSession', loadResult),
        };
      }
    }

    const sessionResult = await connection.newSession({
      cwd: options.workingDir,
      mcpServers,
    });
    logger.info('ACP session created', {
      sessionId,
      providerSessionId: sessionResult.sessionId,
    });
    return {
      providerSessionId: sessionResult.sessionId,
      configOptions: requireSessionConfigOptions(options.provider, 'newSession', sessionResult),
    };
  }

  async stopClient(sessionId: string): Promise<void> {
    if (this.stoppingInProgress.has(sessionId)) {
      logger.debug('ACP session stop already in progress', { sessionId });
      return;
    }

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
          await handle.connection.cancel({
            sessionId: handle.providerSessionId,
          });
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

    handle.isPromptInFlight = true;
    try {
      const promptPromise = handle.connection.prompt({
        sessionId: handle.providerSessionId,
        prompt,
      });

      let result: { stopReason: string };
      if (timeoutMs != null && timeoutMs > 0) {
        result = await new Promise<{ stopReason: string }>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new PromptTimeoutError(sessionId, timeoutMs)),
            timeoutMs
          );
          promptPromise.then(
            (r) => {
              clearTimeout(timer);
              resolve(r);
            },
            (e) => {
              clearTimeout(timer);
              reject(e);
            }
          );
        });
      } else {
        result = await promptPromise;
      }

      handle.isPromptInFlight = false;
      return { stopReason: result.stopReason };
    } catch (error) {
      if (error instanceof PromptTimeoutError) {
        await this.escalatePromptTimeout(sessionId, timeoutMs);
      }
      handle.isPromptInFlight = false;
      throw error;
    }
  }

  /** Attempt graceful cancel after a prompt timeout, then escalate to kill. */
  private async escalatePromptTimeout(
    sessionId: string,
    timeoutMs: number | undefined
  ): Promise<void> {
    logger.warn('Prompt timed out, attempting cancel', { sessionId, timeoutMs });
    try {
      const cancelled = await Promise.race([
        this.cancelPrompt(sessionId).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!cancelled) {
        logger.warn('Cancel timed out after prompt timeout, stopping client', { sessionId });
        this.clearPromptInFlight(sessionId);
        await this.stopClient(sessionId).catch(() => {
          // Best-effort cleanup
        });
      }
    } catch {
      // Cancel failed — stop the client forcibly
      logger.warn('Cancel failed after timeout, stopping client', { sessionId });
      this.clearPromptInFlight(sessionId);
      await this.stopClient(sessionId).catch(() => {
        // Best-effort cleanup
      });
    }
  }

  private clearPromptInFlight(sessionId: string): void {
    const handle = this.sessions.get(sessionId);
    if (handle) {
      handle.isPromptInFlight = false;
    }
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      return;
    }

    if (handle.isPromptInFlight) {
      await handle.connection.cancel({
        sessionId: handle.providerSessionId,
      });
    }
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<SessionConfigOption[]> {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      throw new Error(`No ACP session found for sessionId: ${sessionId}`);
    }

    try {
      const response = await handle.connection.setSessionConfigOption({
        sessionId: handle.providerSessionId,
        configId,
        value,
      });

      const configOptions = requireSessionConfigOptions(handle.provider, 'setSessionConfigOption', {
        configOptions: response.configOptions,
      });
      handle.configOptions = configOptions;
      return configOptions;
    } catch (error) {
      logger.warn('setSessionConfigOption failed', {
        sessionId,
        configId,
        provider: handle.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<SessionConfigOption[]> {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      throw new Error(`No ACP session found for sessionId: ${sessionId}`);
    }

    try {
      await handle.connection.setSessionMode({
        sessionId: handle.providerSessionId,
        modeId,
      });

      handle.configOptions = handle.configOptions.map((option) =>
        option.category === 'mode' ? { ...option, currentValue: modeId } : option
      );

      return [...handle.configOptions];
    } catch (error) {
      logger.warn('setSessionMode failed', {
        sessionId,
        modeId,
        provider: handle.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<SessionConfigOption[]> {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      throw new Error(`No ACP session found for sessionId: ${sessionId}`);
    }

    const applyModelToCache = (): SessionConfigOption[] => {
      handle.configOptions = handle.configOptions.map((option) =>
        option.category === 'model' ? { ...option, currentValue: modelId } : option
      );
      return [...handle.configOptions];
    };

    if (handle.provider === 'CLAUDE') {
      try {
        await handle.connection.unstable_setSessionModel({
          sessionId: handle.providerSessionId,
          modelId,
        });
        return applyModelToCache();
      } catch (error) {
        if (!isMethodNotFoundError(error)) {
          logger.warn('setSessionModel failed', {
            sessionId,
            modelId,
            provider: handle.provider,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        logger.warn(
          'unstable_setSessionModel unavailable, falling back to setSessionConfigOption',
          {
            sessionId,
            modelId,
            provider: handle.provider,
          }
        );
      }
    }

    return await this.setConfigOption(sessionId, 'model', modelId);
  }

  async stopAllClients(timeoutMs = 5000): Promise<void> {
    this.beginShutdown();

    await this.stopCurrentClients(timeoutMs);
    await this.waitForPendingCreations(timeoutMs);
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
    const handle = this.sessions.get(sessionId);
    return handle?.isRunning() ?? false;
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
