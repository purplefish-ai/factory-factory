import { type ChildProcess, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  type LoadSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
} from '@agentclientprotocol/sdk/unstable';
import { createLogger, getCurrentProcessEnv } from '@/backend/services/logger.service';
import { AcpClientHandler } from './acp-client-handler';
import { createAcpConnection, type AcpConnection } from './acp-connection';
import { isAcpHistoryReplayEnd } from './acp-history-replay';
import { applyAcpStartupModel } from './acp-model-selection';
import { AcpNativeSessionTracker } from './acp-native-session-tracker';
import { stopOwnedRuntimeGroup } from './acp-owned-group';
import { AcpProcessHandle } from './acp-process-handle';
import type { AcpRuntimeMetadata, AcpStartupSignal } from './acp-runtime-contracts';
import { wireAcpRuntimeErrorHandler } from './acp-runtime-error-handler';
import {
  AcpBrowseSessionUnavailableError,
  createAcpResumeError,
  getAcpErrorLogDetails,
  isAcpSessionInUseError,
} from './acp-runtime-errors';
import type {
  AcpRuntimeEvent,
  AcpRuntimeEventHandlers,
  AcpSessionCreationOutcome,
} from './acp-runtime-events';
import { raceWithSoftTimeout } from './acp-runtime-quiescence';
import {
  createAcpSpawnError,
  resolveProviderAcpSpawnCommand,
  type SpawnCommand,
  validateAcpWorkingDir,
  withTimeout,
} from './acp-runtime-spawn';
import { requireSessionConfigOptions } from './acp-session-config-options';
import { toAcpSessionId } from './acp-session-identity';
import { supportsAcpSteering } from './acp-steering';
import { createNormalizedAcpReadableStream } from './acp-stream-normalizer';
import type { AcpClientOptions } from './types';

const logger = createLogger('acp-runtime-manager');
const DEFAULT_ACP_STARTUP_TIMEOUT_MS = 30_000;
// Session creation (new/load/resume) and the follow-up model configuration run
// provider-side work that can block for tens of seconds on a slow machine, while
// the initialize handshake stays fast. A slow start should not become a failure.
const DEFAULT_ACP_SESSION_CREATION_TIMEOUT_MS = 120_000;

function normalizeTimeoutMs(timeoutMs: number, fallbackMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : fallbackMs;
}

export type CreateAcpClientParams = {
  sessionId: string;
  options: AcpClientOptions;
  handlers: AcpRuntimeEventHandlers;
  metadata: AcpRuntimeMetadata;
  shutdownSignal: AcpStartupSignal;
  stopSignal: AcpStartupSignal;
  shouldDispatchRuntimeError(child: ChildProcess): boolean;
  discardFailedResumeReplay?(): void;
  onOwnedProcessSpawned?(
    child: ChildProcess,
    group: number | undefined,
    unsupported: boolean
  ): () => Promise<'LOCAL_RUNTIME_GROUP_STOPPED' | 'UNKNOWN'>;
};

function resolveSpawnCommand(options: AcpClientOptions): SpawnCommand {
  if (options.adapterBinaryPath) {
    return {
      command: options.adapterBinaryPath,
      args: [],
      commandLabel: options.adapterBinaryPath,
    };
  }
  return resolveProviderAcpSpawnCommand(options.provider);
}

export class AcpClientFactory {
  private acpStartupTimeoutMs = DEFAULT_ACP_STARTUP_TIMEOUT_MS;
  private acpSessionCreationTimeoutMs = DEFAULT_ACP_SESSION_CREATION_TIMEOUT_MS;
  private childProcessEnvProvider: () => NodeJS.ProcessEnv = getCurrentProcessEnv;

  constructor(options?: { acpStartupTimeoutMs?: number; acpSessionCreationTimeoutMs?: number }) {
    this.setAcpStartupTimeoutMs(options?.acpStartupTimeoutMs ?? DEFAULT_ACP_STARTUP_TIMEOUT_MS);
    this.setAcpSessionCreationTimeoutMs(
      options?.acpSessionCreationTimeoutMs ?? DEFAULT_ACP_SESSION_CREATION_TIMEOUT_MS
    );
  }

  /** Deadline for the ACP initialize handshake. */
  setAcpStartupTimeoutMs(timeoutMs: number): void {
    this.acpStartupTimeoutMs = normalizeTimeoutMs(timeoutMs, DEFAULT_ACP_STARTUP_TIMEOUT_MS);
  }

  /** Deadline for provider session new/load/resume and startup model configuration. */
  setAcpSessionCreationTimeoutMs(timeoutMs: number): void {
    this.acpSessionCreationTimeoutMs = normalizeTimeoutMs(
      timeoutMs,
      DEFAULT_ACP_SESSION_CREATION_TIMEOUT_MS
    );
  }

  configureEnvironment(options: { childProcessEnvProvider: () => NodeJS.ProcessEnv }): void {
    this.childProcessEnvProvider = options.childProcessEnvProvider;
  }

  async createClient(params: CreateAcpClientParams): Promise<AcpProcessHandle> {
    const { sessionId, options, handlers, metadata, shutdownSignal, stopSignal } = params;
    const startupTimeoutMs = this.acpStartupTimeoutMs;
    const sessionCreationTimeoutMs = this.acpSessionCreationTimeoutMs;
    validateAcpWorkingDir(options.workingDir);

    const spawnCommand = resolveSpawnCommand(options);
    const isCodex = options.provider === 'CODEX';
    logger.info('Spawning ACP subprocess', {
      sessionId,
      command: spawnCommand.command,
      args: spawnCommand.args,
      provider: options.provider,
      workingDir: options.workingDir,
    });

    const runtimeEnv =
      isCodex && options.codexAccountContext
        ? options.codexAccountContext.env
        : this.childProcessEnvProvider();
    const ownsGroup = options.ownedProcessGroup === true && process.platform !== 'win32';
    options.assertCurrentSync?.();
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: options.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...runtimeEnv,
        BROWSER: 'none',
        ELECTRON_RUN_AS_NODE: '1',
        ...(isCodex ? { DOTENV_CONFIG_QUIET: 'true', DISABLE_MCP_CONFIG_FILTERING: 'true' } : {}),
      },
      detached: ownsGroup,
    });

    const cleanupOwned = registerOwnedSpawn(params, child, ownsGroup, runtimeEnv);

    let spawned = child.pid !== undefined;
    let spawnFailed = false;
    child.once('spawn', () => {
      spawned = true;
    });
    let startupErrorListener: ((error: unknown) => void) | null = null;
    const startupError = new Promise<never>((_resolve, reject) => {
      startupErrorListener = (error: unknown) => {
        spawnFailed = isDefinitiveSpawnFailure(spawned, child);
        reject(createAcpSpawnError(spawnCommand.commandLabel, error));
      };
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
      let replayingHistory = Boolean(options.resumeProviderSessionId);
      const onEvent = (sid: string, event: AcpRuntimeEvent) => {
        // Raw tracking can read ahead of SDK notifications; use their delivered marker.
        if (event.type === 'acp_session_update' && isAcpHistoryReplayEnd(event.update)) {
          replayingHistory = false;
        }
        if (replayingHistory && handlers.consumeReplayEvent?.(sid, event)) {
          return;
        }
        handlers.onAcpEvent?.(sid, event);
      };
      const nativeSessionTracker = new AcpNativeSessionTracker({
        groupCodexGenerations: isCodex,
        onSubagentsChanged: (event) =>
          onEvent(sessionId, {
            type: 'acp_subagents_changed',
            subagentId: event.subagentId,
            change: event.change,
          }),
        onTaskStatusChanged: (active) =>
          onEvent(sessionId, { type: 'acp_task_status_changed', active }),
        onSubagentToolUpdate: (subagentId, update) =>
          onEvent(sessionId, {
            type: 'acp_subagent_tool_update',
            subagentId,
            update,
          }),
      });
      if (options.resumeProviderSessionId) {
        nativeSessionTracker.setRootSessionId(
          toAcpSessionId(options.provider, options.resumeProviderSessionId)
        );
        nativeSessionTracker.beginHistoryReplay(isCodex);
      }
      const normalizedStream = {
        writable: stream.writable,
        readable: createNormalizedAcpReadableStream(stream.readable, (message) =>
          nativeSessionTracker.onRawMessage(message)
        ),
      };

      const connection = createAcpConnection(
        new AcpClientHandler(sessionId, onEvent, handlers.permissionBridge, handlers.onAcpLog),
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
            clientCapabilities: {
              session: { compaction: {} },
              subagents: {},
              elicitation: { form: {}, url: {} },
              _meta: {
                terminal_output_delta: true,
                jetbrains: {
                  air: {
                    version: 1,
                    capabilities: ['asyncTasks', 'sessionFailure', 'loadReplayEnd'],
                  },
                },
              },
            },
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

      if (options.beforeSessionCreation) {
        await Promise.race([
          // Local history previously completed before ACP startup. Keep its
          // wait cancellable without imposing a provider RPC deadline on IO.
          options.beforeSessionCreation(),
          startupError,
          shutdownSignal.promise,
          stopSignal.promise,
        ]);
      }

      const agentCapabilities = initResult.agentCapabilities ?? {};
      nativeSessionTracker.setCapabilities(agentCapabilities);
      const sessionInfo = await Promise.race([
        withTimeout({
          promise: this.createOrResumeSession(
            connection,
            sessionId,
            options,
            agentCapabilities,
            () => {
              replayingHistory = false;
              nativeSessionTracker.resetSession();
              params.discardFailedResumeReplay?.();
            }
          ),
          timeoutMs: sessionCreationTimeoutMs,
          description: 'session creation',
          cancelOn: startupCancelOn,
        }),
        startupError,
        shutdownSignal.promise,
        stopSignal.promise,
      ]);

      replayingHistory = false;
      nativeSessionTracker.setRootSessionId(
        toAcpSessionId(options.provider, sessionInfo.providerSessionId)
      );
      nativeSessionTracker.completeHistoryReplay();
      const handle = new AcpProcessHandle({
        nativeSessionTracker,
        permissionBridge: handlers.permissionBridge,
        connection,
        child,
        provider: options.provider,
        providerSessionId: sessionInfo.providerSessionId,
        sessionCreationOutcome: sessionInfo.outcome,
        agentCapabilities,
        supportsSteering: supportsAcpSteering(initResult._meta),
      });
      registerOwnedGroup(handle, ownsGroup, options, runtimeEnv);
      handle.configOptions =
        options.purpose === 'browse'
          ? sessionInfo.configOptions
          : await Promise.race([
              withTimeout({
                promise: applyAcpStartupModel({
                  connection,
                  provider: options.provider,
                  providerSessionId: handle.acpSessionId,
                  configOptions: sessionInfo.configOptions,
                  model: options.model,
                }),
                timeoutMs: sessionCreationTimeoutMs,
                description: 'model configuration',
                cancelOn: startupCancelOn,
              }),
              startupError,
              shutdownSignal.promise,
              stopSignal.promise,
            ]);
      return handle;
    } catch (error) {
      await cleanupEventRuntimeFailure(
        child,
        sessionId,
        options.ownedProcessGroup === true,
        error,
        cleanupOwned,
        spawnFailed
      );
      throw error;
    } finally {
      if (startupErrorListener) {
        child.removeListener('error', startupErrorListener);
        startupErrorListener = null;
      }
    }
  }

  private async createOrResumeSession(
    connection: AcpConnection,
    sessionId: string,
    options: AcpClientOptions,
    agentCapabilities: Record<string, unknown>,
    discardFailedResumeReplay?: () => void
  ): Promise<{
    providerSessionId: string;
    configOptions: SessionConfigOption[];
    outcome: AcpSessionCreationOutcome;
  }> {
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
      return { ...resumed, outcome: { kind: 'resumed' } };
    }

    if (options.resumePolicy === 'require_existing') {
      throw new Error('Cannot restore the existing provider conversation for PR monitoring');
    }
    if (browseOnly) {
      throw new AcpBrowseSessionUnavailableError(
        storedId
          ? 'Provider does not support restoring this session for sub-agent browsing.'
          : 'Stored provider session is required for sub-agent browsing.'
      );
    }

    if (storedId && options.provider === 'CODEX') {
      throw new Error('Codex does not support restoring the saved conversation');
    }
    if (storedId) {
      discardFailedResumeReplay?.();
    }
    const sessionResult = await connection.newSession({ cwd: options.workingDir, mcpServers });
    logger.info('ACP session created', {
      sessionId,
      providerSessionId: sessionResult.sessionId,
    });
    return {
      providerSessionId: sessionResult.sessionId,
      outcome: storedId
        ? {
            kind: 'resume_fallback',
            previousProviderSessionId: storedId,
            reason: agentCapabilities.loadSession === true ? 'load_failed' : 'load_unsupported',
          }
        : { kind: 'new' },
      configOptions: requireSessionConfigOptions(options.provider, 'newSession', sessionResult),
    };
  }

  private async tryLoadStoredSession(
    connection: AcpConnection,
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
        sessionId: toAcpSessionId(options.provider, storedId),
        cwd: options.workingDir,
        mcpServers,
      });
    } catch (error) {
      const requireExisting =
        options.provider === 'CODEX' ||
        options.resumePolicy === 'require_existing' ||
        isAcpSessionInUseError(error);
      this.logLoadSessionFailure(
        sessionId,
        storedId,
        error,
        options.purpose === 'browse',
        !requireExisting
      );
      if (options.purpose === 'browse') {
        throw new AcpBrowseSessionUnavailableError(
          'Provider failed to restore this session for sub-agent browsing.',
          { cause: error }
        );
      }
      if (requireExisting) {
        throw createAcpResumeError(options.provider, storedId, error);
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
    browseOnly: boolean,
    allowFallback: boolean
  ): void {
    const details = getAcpErrorLogDetails(error);
    logger.warn(browseOnly ? 'Browse-only loadSession failed' : 'loadSession failed', {
      sessionId,
      storedProviderSessionId,
      error: details.message,
      ...(details.code !== undefined ? { errorCode: details.code } : {}),
      ...(typeof details.data !== 'undefined' ? { errorData: details.data } : {}),
      ...(!browseOnly && allowFallback ? { fallback: 'newSession' } : {}),
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

function registerOwnedGroup(
  handle: AcpProcessHandle,
  owned: boolean,
  options: AcpClientOptions,
  env: NodeJS.ProcessEnv
): void {
  if (!options.ownedProcessGroup) {
    return;
  }
  handle.ownedProcessGroup = owned ? handle.child.pid : undefined;
  handle.eventLifecycleGeneration = options.eventLifecycleGeneration;
  handle.unsupportedProcessOverride = Boolean(
    options.adapterBinaryPath || env.CLAUDE_CODE_EXECUTABLE
  );
}
async function cleanupEventRuntimeFailure(
  child: ChildProcess,
  sessionId: string,
  owned: boolean,
  error: unknown,
  cleanup?: () => Promise<'LOCAL_RUNTIME_GROUP_STOPPED' | 'UNKNOWN'>,
  spawnFailed = false
): Promise<void> {
  if (!owned) {
    return await cleanupFailedAcpClientCreation(child, sessionId);
  }
  if (spawnFailed) {
    return;
  }
  if (
    (await (cleanup?.() ??
      stopOwnedRuntimeGroup({
        child,
        ownedProcessGroup: process.platform === 'win32' ? undefined : child.pid,
      }))) !== 'LOCAL_RUNTIME_GROUP_STOPPED'
  ) {
    throw new Error('Event runtime startup cleanup is unconfirmed', { cause: error });
  }
}

function registerOwnedSpawn(
  params: CreateAcpClientParams,
  child: ChildProcess,
  ownsGroup: boolean,
  env: NodeJS.ProcessEnv
) {
  return params.options.ownedProcessGroup
    ? params.onOwnedProcessSpawned?.(
        child,
        ownsGroup ? child.pid : undefined,
        Boolean(params.options.adapterBinaryPath || env.CLAUDE_CODE_EXECUTABLE)
      )
    : undefined;
}

function isDefinitiveSpawnFailure(spawned: boolean, child: ChildProcess): boolean {
  return !spawned && child.pid === undefined;
}
