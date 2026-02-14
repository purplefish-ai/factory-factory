import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import pLimit from 'p-limit';
import { createLogger } from '@/backend/services/logger.service';
import { AcpClientHandler } from './acp-client-handler';
import type { AcpPermissionBridge } from './acp-permission-bridge';
import { AcpProcessHandle } from './acp-process-handle';
import type { AcpClientOptions } from './types';

const logger = createLogger('acp-runtime-manager');

export type AcpRuntimeCreatedCallback = (
  sessionId: string,
  client: AcpProcessHandle,
  context: { workspaceId: string; workingDir: string }
) => void;

export type AcpRuntimeEventHandlers = {
  onSessionId?: (sessionId: string, providerSessionId: string) => Promise<void>;
  onExit?: (sessionId: string, code: number | null) => Promise<void>;
  onError?: (sessionId: string, error: Error) => Promise<void> | void;
  onAcpEvent?: (sessionId: string, event: unknown) => void;
  onAcpLog?: (sessionId: string, payload: Record<string, unknown>) => void;
  /** Permission bridge to inject into AcpClientHandler for suspending requestPermission */
  permissionBridge?: AcpPermissionBridge;
};

/**
 * Resolves the full path to an ACP adapter binary by finding its package
 * directory and reading the bin field from package.json.
 * Falls back to the bare command name (relies on PATH).
 */
function resolveAcpBinary(packageName: string, binaryName: string): string {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const packageDir = dirname(packageJsonPath);
    // biome-ignore lint/suspicious/noExplicitAny: reading package.json bin field
    const pkg = require(packageJsonPath) as any;
    const binPath = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binaryName];
    if (binPath) {
      return join(packageDir, binPath);
    }
  } catch {
    logger.debug('Could not resolve binary via package.json, falling back to PATH', {
      packageName,
      binaryName,
    });
  }
  return binaryName;
}

export class AcpRuntimeManager {
  private readonly sessions = new Map<string, AcpProcessHandle>();
  private readonly pendingCreation = new Map<string, Promise<AcpProcessHandle>>();
  private readonly stoppingInProgress = new Set<string>();
  private readonly creationLocks = new Map<string, ReturnType<typeof pLimit>>();
  private readonly lockRefCounts = new Map<string, number>();
  private onClientCreatedCallback: AcpRuntimeCreatedCallback | null = null;

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
    // Resolve binary path
    const isCodex = options.provider === 'CODEX';
    const binaryName = isCodex ? 'codex-acp' : 'claude-code-acp';
    const packageName = isCodex ? '@zed-industries/codex-acp' : '@zed-industries/claude-code-acp';
    const binaryPath = resolveAcpBinary(packageName, binaryName);

    logger.info('Spawning ACP subprocess', {
      sessionId,
      binaryPath,
      provider: options.provider,
      workingDir: options.workingDir,
    });

    // Spawn subprocess (CRITICAL: detached MUST be false for orphan prevention)
    const child: ChildProcess = spawn(binaryPath, [], {
      cwd: options.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: false,
    });

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

    // Create event callback that routes to handlers
    const acpEventHandler = handlers.onAcpEvent;
    const onEvent = acpEventHandler
      ? (sid: string, event: unknown) => acpEventHandler(sid, event)
      : (_sid: string, _event: unknown) => {
          logger.debug('ACP event received but no handler registered', { sessionId });
        };

    // Create connection with client handler (inject permission bridge from handlers)
    const connection = new ClientSideConnection(
      (_agent) =>
        new AcpClientHandler(sessionId, onEvent, handlers.permissionBridge, handlers.onAcpLog),
      stream
    );

    // Initialize handshake
    const initResult = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: {
        name: 'factory-factory',
        title: 'Factory Factory',
        version: '1.2.0',
      },
    });

    logger.info('ACP connection initialized', {
      sessionId,
      agentCapabilities: initResult.agentCapabilities,
    });

    // Create or resume provider session
    const agentCapabilities = initResult.agentCapabilities ?? {};
    const sessionInfo = await this.createOrResumeSession(
      connection,
      sessionId,
      options,
      agentCapabilities
    );

    // Build handle
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

    // Wire child exit handler
    child.on('exit', async (code) => {
      this.sessions.delete(sessionId);
      this.pendingCreation.delete(sessionId);

      if (this.stoppingInProgress.has(sessionId)) {
        logger.debug('Skipping exit handler - stop in progress', { sessionId, code });
        return;
      }

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

    // Wire child error handler
    child.on('error', async (error) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
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

    // Notify callback
    if (this.onClientCreatedCallback) {
      this.onClientCreatedCallback(sessionId, handle, context);
    }

    // Notify session ID handler
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

    return handle;
  }

  private async createOrResumeSession(
    connection: ClientSideConnection,
    sessionId: string,
    options: AcpClientOptions,
    agentCapabilities: Record<string, unknown>
  ): Promise<{
    providerSessionId: string;
    configOptions: import('@agentclientprotocol/sdk').SessionConfigOption[];
  }> {
    const storedId = options.resumeProviderSessionId;
    const canResume = agentCapabilities.loadSession === true && !!storedId;

    if (canResume && storedId) {
      try {
        const loadResult = await connection.loadSession({
          sessionId: storedId,
          cwd: options.workingDir,
          mcpServers: [],
        });
        logger.info('ACP session resumed via loadSession', {
          sessionId,
          providerSessionId: storedId,
        });
        return {
          providerSessionId: storedId,
          configOptions: loadResult.configOptions ?? [],
        };
      } catch (error) {
        logger.warn('loadSession failed, falling back to newSession', {
          sessionId,
          storedProviderSessionId: storedId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const sessionResult = await connection.newSession({
      cwd: options.workingDir,
      mcpServers: [],
    });
    logger.info('ACP session created', {
      sessionId,
      providerSessionId: sessionResult.sessionId,
    });
    return {
      providerSessionId: sessionResult.sessionId,
      configOptions: sessionResult.configOptions ?? [],
    };
  }

  async stopClient(sessionId: string): Promise<void> {
    if (this.stoppingInProgress.has(sessionId)) {
      logger.debug('ACP session stop already in progress', { sessionId });
      return;
    }

    const handle = this.sessions.get(sessionId);
    if (!handle) {
      return;
    }

    this.stoppingInProgress.add(sessionId);
    try {
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

      // Send SIGTERM
      handle.child.kill('SIGTERM');

      // Wait for exit or timeout
      const exitPromise = new Promise<void>((resolve) => {
        handle.child.on('exit', () => resolve());
        // If already exited, resolve immediately
        if (handle.child.exitCode !== null) {
          resolve();
        }
      });
      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5000));
      await Promise.race([exitPromise, timeoutPromise]);

      // Escalate to SIGKILL if still alive
      if (handle.child.exitCode === null && !handle.child.killed) {
        logger.warn('ACP process did not exit after SIGTERM, escalating to SIGKILL', {
          sessionId,
          pid: handle.getPid(),
        });
        handle.child.kill('SIGKILL');
      }
    } finally {
      this.stoppingInProgress.delete(sessionId);
      this.sessions.delete(sessionId);
    }
  }

  async sendPrompt(sessionId: string, content: string): Promise<{ stopReason: string }> {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      throw new Error(`No ACP session found for sessionId: ${sessionId}`);
    }

    handle.isPromptInFlight = true;
    try {
      const result = await handle.connection.prompt({
        sessionId: handle.providerSessionId,
        prompt: [{ type: 'text', text: content }],
      });
      handle.isPromptInFlight = false;
      return { stopReason: result.stopReason };
    } catch (error) {
      handle.isPromptInFlight = false;
      throw error;
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
  ): Promise<import('@agentclientprotocol/sdk').SessionConfigOption[]> {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      throw new Error(`No ACP session found for sessionId: ${sessionId}`);
    }

    const response = await handle.connection.setSessionConfigOption({
      sessionId: handle.providerSessionId,
      configId,
      value,
    });

    handle.configOptions = response.configOptions;
    return response.configOptions;
  }

  async stopAllClients(timeoutMs = 5000): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    for (const sessionId of this.sessions.keys()) {
      const stopPromise = Promise.race([
        this.stopClient(sessionId),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      stopPromises.push(stopPromise);
    }

    await Promise.all(stopPromises);

    this.sessions.clear();
    this.creationLocks.clear();
    this.lockRefCounts.clear();

    logger.info('All ACP clients stopped and cleaned up');
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

export const acpRuntimeManager = new AcpRuntimeManager();
