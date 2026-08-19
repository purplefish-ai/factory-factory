import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  type LoadSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { createLogger, getCurrentProcessEnv } from '@/backend/services/logger.service';
import { AcpClientHandler, type AutoApprovePolicy } from './acp-client-handler';
import { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimeMetadata, AcpStartupSignal } from './acp-runtime-contracts';
import { wireAcpRuntimeErrorHandler } from './acp-runtime-error-handler';
import { AcpBrowseSessionUnavailableError, getAcpErrorLogDetails } from './acp-runtime-errors';
import type { AcpRuntimeEvent, AcpRuntimeEventHandlers } from './acp-runtime-events';
import { raceWithSoftTimeout } from './acp-runtime-quiescence';
import {
  createAcpSpawnError,
  hasUsableWorkingDir,
  resolveAcpBinary,
  resolveInternalCodexAcpSpawnCommand,
  type SpawnCommand,
  withTimeout,
} from './acp-runtime-spawn';
import { requireSessionConfigOptions } from './acp-session-config-options';
import { createNormalizedAcpReadableStream } from './acp-stream-normalizer';
import type { AcpClientOptions, PermissionPreset } from './types';

const logger = createLogger('acp-runtime-manager');
const DEFAULT_ACP_STARTUP_TIMEOUT_MS = 30_000;

export type CreateAcpClientParams = {
  sessionId: string;
  options: AcpClientOptions;
  handlers: AcpRuntimeEventHandlers;
  metadata: AcpRuntimeMetadata;
  shutdownSignal: AcpStartupSignal;
  stopSignal: AcpStartupSignal;
  shouldDispatchRuntimeError(child: ChildProcess): boolean;
};

function resolveAutoApprovePolicy(preset: PermissionPreset | undefined): AutoApprovePolicy {
  return preset === 'YOLO' || preset === 'RELAXED' ? 'all' : 'none';
}

function resolveSpawnCommand(
  options: AcpClientOptions,
  preferSourceEntrypoint: boolean
): SpawnCommand {
  if (options.adapterBinaryPath) {
    return {
      command: options.adapterBinaryPath,
      args: [],
      commandLabel: options.adapterBinaryPath,
    };
  }
  if (options.provider === 'CODEX') {
    return resolveInternalCodexAcpSpawnCommand(preferSourceEntrypoint);
  }

  const binaryName = 'claude-agent-acp';
  const binaryPath = resolveAcpBinary('@agentclientprotocol/claude-agent-acp', binaryName);
  return {
    command: binaryPath,
    args: [],
    commandLabel: binaryPath,
  };
}

export class AcpClientFactory {
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

  async createClient(params: CreateAcpClientParams): Promise<AcpProcessHandle> {
    const { sessionId, options, handlers, metadata, shutdownSignal, stopSignal } = params;
    const startupTimeoutMs = this.acpStartupTimeoutMs;
    if (!hasUsableWorkingDir(options.workingDir)) {
      throw new Error('ACP working directory is required before spawning adapter process');
    }

    const spawnCommand = resolveSpawnCommand(options, this.preferSourceEntrypoint);
    const isCodex = options.provider === 'CODEX';
    logger.info('Spawning ACP subprocess', {
      sessionId,
      command: spawnCommand.command,
      args: spawnCommand.args,
      provider: options.provider,
      workingDir: options.workingDir,
    });

    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: options.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...this.childProcessEnvProvider(),
        BROWSER: 'none',
        ...(isCodex ? { DOTENV_CONFIG_QUIET: 'true' } : {}),
      },
      detached: false,
    });

    let startupErrorListener: ((error: unknown) => void) | null = null;
    const startupError = new Promise<never>((_resolve, reject) => {
      startupErrorListener = (error: unknown) =>
        reject(createAcpSpawnError(spawnCommand.commandLabel, error));
      child.once('error', startupErrorListener);
    });
    const startupErrorSettled = startupError.catch(() => undefined);

    wireAcpRuntimeErrorHandler(child, sessionId, handlers, metadata, () =>
      params.shouldDispatchRuntimeError(child)
    );

    child.stderr?.on('data', (chunk: Buffer) => {
      handlers.onAcpLog?.(options.sessionId, {
        eventType: 'acp_stderr',
        data: chunk.toString(),
      });
    });

    try {
      if (!(child.stdout && child.stdin)) {
        throw new Error('ACP subprocess stdio streams not available');
      }
      const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
      const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
      const stream = ndJsonStream(output, input);
      const normalizedStream = {
        writable: stream.writable,
        readable: createNormalizedAcpReadableStream(stream.readable),
      };

      const acpEventHandler = handlers.onAcpEvent;
      const onEvent = acpEventHandler
        ? (sid: string, event: AcpRuntimeEvent) => acpEventHandler(sid, event)
        : (_sid: string, _event: AcpRuntimeEvent) => {
            logger.debug('ACP event received but no handler registered', { sessionId });
          };
      const connection = new ClientSideConnection(
        (_agent) =>
          new AcpClientHandler(
            sessionId,
            onEvent,
            handlers.permissionBridge,
            handlers.onAcpLog,
            resolveAutoApprovePolicy(options.permissionPreset)
          ),
        normalizedStream
      );
      const startupCancelOn = Promise.race([
        startupErrorSettled,
        shutdownSignal.promise.catch(() => undefined),
        stopSignal.promise.catch(() => undefined),
      ]);

      const initResult = await Promise.race([
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

      const agentCapabilities = initResult.agentCapabilities ?? {};
      const sessionInfo = await Promise.race([
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

      const handle = new AcpProcessHandle({
        connection,
        child,
        provider: options.provider,
        providerSessionId: sessionInfo.providerSessionId,
        agentCapabilities,
      });
      handle.configOptions = sessionInfo.configOptions;
      return handle;
    } catch (error) {
      await cleanupFailedAcpClientCreation(child, sessionId);
      throw error;
    } finally {
      if (startupErrorListener) {
        child.removeListener('error', startupErrorListener);
        startupErrorListener = null;
      }
    }
  }

  private async createOrResumeSession(
    connection: ClientSideConnection,
    sessionId: string,
    options: AcpClientOptions,
    agentCapabilities: Record<string, unknown>
  ): Promise<{ providerSessionId: string; configOptions: SessionConfigOption[] }> {
    const storedId = options.resumeProviderSessionId;
    const browseOnly = options.purpose === 'browse';
    const mcpServers = (options.mcpServers ?? []).map((server) => ({
      name: server.name,
      command: server.command,
      args: server.args,
      env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
    }));
    const resumed = await this.tryLoadStoredSession(
      connection,
      sessionId,
      options,
      agentCapabilities,
      mcpServers
    );
    if (resumed) {
      return resumed;
    }

    if (browseOnly) {
      throw new AcpBrowseSessionUnavailableError(
        storedId
          ? 'Provider does not support restoring this session for sub-agent browsing.'
          : 'Stored provider session is required for sub-agent browsing.'
      );
    }

    const sessionResult = await connection.newSession({ cwd: options.workingDir, mcpServers });
    logger.info('ACP session created', {
      sessionId,
      providerSessionId: sessionResult.sessionId,
    });
    return {
      providerSessionId: sessionResult.sessionId,
      configOptions: requireSessionConfigOptions(options.provider, 'newSession', sessionResult),
    };
  }

  private async tryLoadStoredSession(
    connection: ClientSideConnection,
    sessionId: string,
    options: AcpClientOptions,
    agentCapabilities: Record<string, unknown>,
    mcpServers: Array<{
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    }>
  ): Promise<{ providerSessionId: string; configOptions: SessionConfigOption[] } | null> {
    const storedId = options.resumeProviderSessionId;
    if (!(agentCapabilities.loadSession === true && storedId)) {
      return null;
    }

    let loadResult: LoadSessionResponse;
    try {
      loadResult = await connection.loadSession({
        sessionId: storedId,
        cwd: options.workingDir,
        mcpServers,
      });
    } catch (error) {
      this.logLoadSessionFailure(sessionId, storedId, error, options.purpose === 'browse');
      if (options.purpose === 'browse') {
        throw new AcpBrowseSessionUnavailableError(
          'Provider failed to restore this session for sub-agent browsing.',
          { cause: error }
        );
      }
      return null;
    }

    logger.info('ACP session resumed via loadSession', {
      sessionId,
      providerSessionId: storedId,
    });
    return {
      providerSessionId: storedId,
      configOptions: requireSessionConfigOptions(options.provider, 'loadSession', loadResult),
    };
  }

  private logLoadSessionFailure(
    sessionId: string,
    storedProviderSessionId: string,
    error: unknown,
    browseOnly: boolean
  ): void {
    const details = getAcpErrorLogDetails(error);
    logger.warn(browseOnly ? 'Browse-only loadSession failed' : 'loadSession failed', {
      sessionId,
      storedProviderSessionId,
      error: details.message,
      ...(details.code !== undefined ? { errorCode: details.code } : {}),
      ...(typeof details.data !== 'undefined' ? { errorData: details.data } : {}),
      ...(!browseOnly ? { fallback: 'newSession' } : {}),
    });
  }
}

export async function cleanupFailedAcpClientCreation(
  child: ChildProcess,
  sessionId: string
): Promise<void> {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) {
    return;
  }

  try {
    let terminationObserved = false;
    const exitPromise = new Promise<void>((resolve) => {
      const resolveOnTermination = () => {
        terminationObserved = true;
        child.removeListener('exit', resolveOnTermination);
        child.removeListener('close', resolveOnTermination);
        resolve();
      };
      child.once('exit', resolveOnTermination);
      child.once('close', resolveOnTermination);
      if (hasExited()) {
        resolveOnTermination();
      }
    });

    child.kill('SIGTERM');
    await raceWithSoftTimeout(exitPromise, 5000);
    if (!(terminationObserved || hasExited())) {
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
