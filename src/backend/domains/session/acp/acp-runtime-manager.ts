import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  ClientSideConnection,
  type LoadSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionModelState,
  type SessionModeState,
} from '@agentclientprotocol/sdk';
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
    const pkg = require(packageJsonPath) as {
      bin?: string | Record<string, string | undefined>;
    };
    const binPath =
      typeof pkg.bin === 'string'
        ? pkg.bin
        : typeof pkg.bin?.[binaryName] === 'string'
          ? pkg.bin[binaryName]
          : undefined;
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

type AcpErrorLogDetails = {
  message: string;
  code?: number | string;
  data?: unknown;
};

function normalizeUnknownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createAcpSpawnError(commandLabel: string, error: unknown): Error {
  const normalized = normalizeUnknownError(error);
  return new Error(`Failed to spawn ACP adapter "${commandLabel}": ${normalized.message}`);
}

type SpawnCommand = {
  command: string;
  args: string[];
  commandLabel: string;
};

function findFactoryRoot(startDir: string): string | null {
  let currentDir = startDir;
  for (;;) {
    const hasPackageJson = existsSync(join(currentDir, 'package.json'));
    const hasCliDistEntrypoint = existsSync(join(currentDir, 'dist', 'src', 'cli', 'index.js'));
    const hasCliSourceEntrypoint = existsSync(join(currentDir, 'src', 'cli', 'index.ts'));
    if (hasPackageJson && (hasCliDistEntrypoint || hasCliSourceEntrypoint)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function resolveFactoryRootForInternalCodexAdapter(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidateStarts = [process.cwd(), moduleDir];

  for (const candidate of candidateStarts) {
    const root = findFactoryRoot(candidate);
    if (root) {
      return root;
    }
  }

  throw new Error('Cannot resolve Factory Factory root for CODEX ACP adapter spawn');
}

function resolveInternalCodexAcpSpawnCommand(): SpawnCommand {
  const projectRoot = resolveFactoryRootForInternalCodexAdapter();
  const cliDistEntrypoint = join(projectRoot, 'dist', 'src', 'cli', 'index.js');
  if (existsSync(cliDistEntrypoint)) {
    const args = [cliDistEntrypoint, 'internal', 'codex-app-server-acp'];
    return {
      command: process.execPath,
      args,
      commandLabel: `${process.execPath} ${args.join(' ')}`.trim(),
    };
  }

  const cliSourceEntrypoint = join(projectRoot, 'src', 'cli', 'index.ts');
  if (existsSync(cliSourceEntrypoint)) {
    const tsxBinary = join(
      projectRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
    );
    if (existsSync(tsxBinary)) {
      const args = [cliSourceEntrypoint, 'internal', 'codex-app-server-acp'];
      return {
        command: tsxBinary,
        args,
        commandLabel: `${tsxBinary} ${args.join(' ')}`.trim(),
      };
    }

    const args = [...process.execArgv, cliSourceEntrypoint, 'internal', 'codex-app-server-acp'];
    return {
      command: process.execPath,
      args,
      commandLabel: `${process.execPath} ${args.join(' ')}`.trim(),
    };
  }

  throw new Error('Cannot resolve CLI entrypoint for CODEX ACP adapter spawn');
}

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

const REQUIRED_CONFIG_CATEGORIES = ['model', 'mode'] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function resolveModelFamilyName(description: string | null | undefined): string | null {
  if (!isNonEmptyString(description)) {
    return null;
  }
  const familyName = description.split('·')[0]?.trim();
  return familyName && familyName.length > 0 ? familyName : null;
}

function normalizeClaudeModelOption(option: SessionConfigSelectOption): SessionConfigSelectOption {
  if (option.value !== 'default') {
    return option;
  }
  const modelFamilyName = resolveModelFamilyName(option.description);
  if (!modelFamilyName) {
    return option;
  }
  return {
    ...option,
    name: modelFamilyName,
  };
}

function isOptionGroup(
  option: SessionConfigSelectOption | SessionConfigSelectGroup
): option is SessionConfigSelectGroup {
  return 'group' in option;
}

function isOptionGroupArray(
  options: SessionConfigOption['options']
): options is SessionConfigSelectGroup[] {
  const [firstOption] = options;
  return firstOption ? isOptionGroup(firstOption) : false;
}

function normalizeClaudeConfigOptions(configOptions: SessionConfigOption[]): SessionConfigOption[] {
  return configOptions.map((configOption) => {
    if (configOption.category !== 'model') {
      return configOption;
    }

    if (isOptionGroupArray(configOption.options)) {
      const normalizedGroups = configOption.options.map((group) => ({
        ...group,
        options: group.options.map(normalizeClaudeModelOption),
      }));

      return {
        ...configOption,
        options: normalizedGroups,
      };
    }

    const normalizedOptions = configOption.options.map(normalizeClaudeModelOption);

    return {
      ...configOption,
      options: normalizedOptions,
    };
  });
}

function normalizeSessionConfigOptions(
  provider: string,
  configOptions: SessionConfigOption[]
): SessionConfigOption[] {
  const providerNormalized =
    provider === 'CLAUDE' ? normalizeClaudeConfigOptions(configOptions) : configOptions;
  return providerNormalized.map((configOption) => {
    if (configOption.category || (configOption.id !== 'model' && configOption.id !== 'mode')) {
      return configOption;
    }
    return {
      ...configOption,
      category: configOption.id,
    };
  });
}

type SessionResultWithFallbackState = {
  configOptions?: SessionConfigOption[] | null;
  models?: SessionModelState | null;
  modes?: SessionModeState | null;
};

function resolveModelConfigOption(
  models: SessionModelState | null | undefined
): SessionConfigOption | null {
  if (!(models && Array.isArray(models.availableModels))) {
    return null;
  }

  const options = models.availableModels
    .filter((entry) => isNonEmptyString(entry.modelId))
    .map((entry) => ({
      value: entry.modelId,
      name: isNonEmptyString(entry.name) ? entry.name : entry.modelId,
      ...(isNonEmptyString(entry.description) ? { description: entry.description } : {}),
    }));
  if (options.length === 0) {
    return null;
  }

  const preferredValue = isNonEmptyString(models.currentModelId) ? models.currentModelId : null;
  const currentValue =
    (preferredValue && options.some((option) => option.value === preferredValue)
      ? preferredValue
      : options[0]?.value) ?? null;
  if (!currentValue) {
    return null;
  }

  return {
    id: 'model',
    name: 'Model',
    type: 'select',
    category: 'model',
    currentValue,
    options,
  };
}

function resolveModeConfigOption(
  modes: SessionModeState | null | undefined
): SessionConfigOption | null {
  if (!(modes && Array.isArray(modes.availableModes))) {
    return null;
  }

  const options = modes.availableModes
    .filter((entry) => isNonEmptyString(entry.id))
    .map((entry) => ({
      value: entry.id,
      name: isNonEmptyString(entry.name) ? entry.name : entry.id,
      ...(isNonEmptyString(entry.description) ? { description: entry.description } : {}),
    }));
  if (options.length === 0) {
    return null;
  }

  const preferredValue = isNonEmptyString(modes.currentModeId) ? modes.currentModeId : null;
  const currentValue =
    (preferredValue && options.some((option) => option.value === preferredValue)
      ? preferredValue
      : options[0]?.value) ?? null;
  if (!currentValue) {
    return null;
  }

  return {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    category: 'mode',
    currentValue,
    options,
  };
}

function fallbackSessionConfigOptions(
  sessionResult: Pick<SessionResultWithFallbackState, 'models' | 'modes'>
): SessionConfigOption[] {
  const fallbackOptions: SessionConfigOption[] = [];
  const modelOption = resolveModelConfigOption(sessionResult.models);
  if (modelOption) {
    fallbackOptions.push(modelOption);
  }
  const modeOption = resolveModeConfigOption(sessionResult.modes);
  if (modeOption) {
    fallbackOptions.push(modeOption);
  }
  return fallbackOptions;
}

function requireSessionConfigOptions(
  provider: string,
  sessionSource: 'newSession' | 'loadSession' | 'setSessionConfigOption',
  sessionResult: SessionResultWithFallbackState
): SessionConfigOption[] {
  let configOptions = Array.isArray(sessionResult.configOptions) ? sessionResult.configOptions : [];

  if (sessionSource !== 'setSessionConfigOption') {
    const fallbackOptions = fallbackSessionConfigOptions(sessionResult);
    if (configOptions.length === 0 && fallbackOptions.length > 0) {
      logger.warn('ACP session response missing configOptions; deriving from models/modes', {
        provider,
        sessionSource,
      });
      configOptions = fallbackOptions;
    }
  }

  if (configOptions.length === 0) {
    throw new Error(
      `ACP ${provider} ${sessionSource} response did not include required configOptions`
    );
  }

  const normalizedConfigOptions = normalizeSessionConfigOptions(provider, configOptions);
  const missingCategories = REQUIRED_CONFIG_CATEGORIES.filter(
    (category) => !normalizedConfigOptions.some((option) => option.category === category)
  );
  if (missingCategories.length > 0) {
    throw new Error(
      `ACP ${provider} ${sessionSource} response missing required config option categories: ${missingCategories.join(', ')}`
    );
  }

  return normalizedConfigOptions;
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
    const isCodex = options.provider === 'CODEX';
    const spawnCommand: SpawnCommand = options.adapterBinaryPath
      ? {
          command: options.adapterBinaryPath,
          args: [],
          commandLabel: options.adapterBinaryPath,
        }
      : isCodex
        ? resolveInternalCodexAcpSpawnCommand()
        : (() => {
            const binaryName = 'claude-code-acp';
            const packageName = '@zed-industries/claude-code-acp';
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

    // Spawn subprocess (CRITICAL: detached MUST be false for orphan prevention)
    const child: ChildProcess = spawn(spawnCommand.command, spawnCommand.args, {
      cwd: options.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
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

    this.wireChildErrorHandler(child, sessionId, handlers);

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

    let initResult: Awaited<ReturnType<ClientSideConnection['initialize']>>;
    let sessionInfo: Awaited<ReturnType<AcpRuntimeManager['createOrResumeSession']>>;

    try {
      // Initialize handshake
      initResult = await Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: {
            name: 'factory-factory',
            title: 'Factory Factory',
            version: '1.2.0',
          },
        }),
        startupError,
      ]);

      logger.info('ACP connection initialized', {
        sessionId,
        agentCapabilities: initResult.agentCapabilities,
      });

      // Create or resume provider session
      const agentCapabilities = initResult.agentCapabilities ?? {};
      sessionInfo = await Promise.race([
        this.createOrResumeSession(connection, sessionId, options, agentCapabilities),
        startupError,
      ]);
    } catch (error) {
      this.cleanupFailedClientCreation(child, sessionId);
      throw error;
    } finally {
      if (startupErrorListener) {
        child.removeListener('error', startupErrorListener);
        startupErrorListener = null;
      }
    }

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

  private wireChildExitHandler(
    sessionId: string,
    child: ChildProcess,
    handlers: AcpRuntimeEventHandlers
  ): void {
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

    if (canResume && storedId) {
      let loadResult: LoadSessionResponse | null = null;
      try {
        loadResult = await connection.loadSession({
          sessionId: storedId,
          cwd: options.workingDir,
          mcpServers: [],
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
      mcpServers: [],
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

      const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 5000));
      await Promise.race([exitPromise, timeoutPromise]);

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
