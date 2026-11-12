import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import {
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigOption,
  type SessionConfigSelectOption,
} from '@agentclientprotocol/sdk/unstable';
import { createLogger, getCurrentProcessEnv } from '@/backend/services/logger.service';
import {
  isNativeModeConfigOption,
  isReasoningConfigOption,
} from './acp-config-option-identification';
import { createAcpConnection } from './acp-connection';
import { applyAcpStartupModel } from './acp-model-selection';
import {
  createAcpSpawnError,
  resolveProviderAcpSpawnCommand,
  terminateCatalogProcess,
  withTimeout,
} from './acp-runtime-spawn';
import { requireSessionConfigOptions } from './acp-session-config-options';
import { timeLaunchDiscovery } from './launch-discovery-timing';

/** Native observations crossing the ACP boundary; application defaults are applied by lifecycle. */
export type NativeSessionLaunchOptions = {
  provider: 'CLAUDE' | 'CODEX';
  model: string;
  reasoning: {
    options: Array<{ value: string; label: string; description?: string }>;
    selected?: string;
    defaultValue?: string;
  };
  planMode: { supported: boolean; selected: boolean };
  accessMode: {
    options: Array<{ value: string; label: string; description?: string }>;
    selected?: string;
  };
};
const logger = createLogger('session-launch-options-probe');
const TIMEOUT_MS = 30_000;
// Provider session startup can stall well past 30s on a loaded machine (for
// example while macOS fseventsd is saturated). Discovery runs in the
// background, so a slow answer is better than none.
const SESSION_CREATION_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 1000;
const MAX_ADDITIONAL_MODELS = 64;
function choices(option: SessionConfigOption | undefined): SessionConfigSelectOption[] {
  return option?.type === 'select'
    ? option.options.flatMap((entry) => ('group' in entry ? entry.options : [entry]))
    : [];
}
export function launchOptionsFromConfig(
  provider: 'CLAUDE' | 'CODEX',
  config: SessionConfigOption[]
): NativeSessionLaunchOptions {
  const model = config.find((option) => option.category === 'model');
  if (typeof model?.currentValue !== 'string' || !model.currentValue) {
    throw new Error('Native provider did not confirm a model');
  }
  const effort = config.find(isReasoningConfigOption);
  const effortOptions = choices(effort);
  const selected =
    typeof effort?.currentValue === 'string' &&
    effortOptions.some((option) => option.value === effort.currentValue)
      ? effort.currentValue
      : undefined;
  const plan = config.find((option) =>
    isNativeModeConfigOption(option, provider === 'CLAUDE' ? 'mode' : 'collaboration_mode')
  );
  const access = config.find((option) => isNativeModeConfigOption(option, 'mode'));
  return {
    provider,
    model: model.currentValue,
    reasoning: {
      options: effortOptions.map((option) => ({
        value: option.value,
        label: option.name,
        ...(option.description ? { description: option.description } : {}),
      })),
      ...(selected !== undefined ? { selected, defaultValue: selected } : {}),
    },
    accessMode: {
      options: choices(access)
        .filter((option) => option.value !== 'plan')
        .map((option) => ({
          value: option.value,
          label: option.name,
          ...(option.description ? { description: option.description } : {}),
        })),
      ...(typeof access?.currentValue === 'string' ? { selected: access.currentValue } : {}),
    },
    planMode: {
      supported: choices(plan).some((option) => option.value === 'plan'),
      selected: plan?.currentValue === 'plan',
    },
  };
}
type ProbeInput = {
  provider: 'CLAUDE' | 'CODEX';
  model?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /**
   * Chooses which other advertised models to capture in the same disposable
   * session after the requested one. Their options omit thinking defaults,
   * because a model switch may carry the previous model's level forward.
   */
  selectAdditionalModels?: (models: readonly string[]) => readonly string[];
};
/**
 * Bounded discovery result, with a separately retained native child/pipe
 * lifetime. `result` settles as soon as the requested model is known;
 * `additional` settles after the remaining selected models were captured.
 */
export function fetchSessionLaunchOptionsFromAcp(input: ProbeInput) {
  let lifetime = Promise.resolve();
  let deliver!: (options: NativeSessionLaunchOptions) => void;
  const requested = new Promise<NativeSessionLaunchOptions>((resolve) => {
    deliver = resolve;
  });
  const probe = probeLaunchOptions(
    input,
    (drained) => {
      lifetime = drained;
    },
    deliver
  );
  return {
    result: Promise.race([requested, probe.then(() => requested)]),
    additional: probe.catch((): NativeSessionLaunchOptions[] => []),
    drained: probe.then(
      () => lifetime,
      () => lifetime
    ),
  };
}

function withoutThinkingDefaults(options: NativeSessionLaunchOptions): NativeSessionLaunchOptions {
  return { ...options, reasoning: { options: options.reasoning.options } };
}

/** Disposable native configuration discovery. No prompt is submitted. */
async function probeLaunchOptions(
  input: ProbeInput,
  retainLifetime: (drained: Promise<void>) => void,
  deliver: (options: NativeSessionLaunchOptions) => void
): Promise<NativeSessionLaunchOptions[]> {
  input.signal?.throwIfAborted();
  const command = resolveProviderAcpSpawnCommand(input.provider);
  const cwd = tmpdir();
  const child = spawn(command.command, command.args, {
    cwd,
    ...(input.signal ? { signal: input.signal } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...(input.env ?? getCurrentProcessEnv()),
      BROWSER: 'none',
      ELECTRON_RUN_AS_NODE: '1',
      ...(input.provider === 'CODEX'
        ? { DOTENV_CONFIG_QUIET: 'true', DISABLE_MCP_CONFIG_FILTERING: 'true' }
        : {}),
    },
  });
  // Observe before ACP setup or cleanup: exit and signal requests do not close pipes.
  const childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  retainLifetime(childClosed);
  let spawnListener: ((error: Error) => void) | undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    spawnListener = (error) =>
      reject(
        error.name === 'AbortError' && input.signal?.aborted
          ? input.signal.reason
          : createAcpSpawnError(command.commandLabel, error)
      );
    child.on('error', spawnListener);
  });
  void childClosed.then(() => {
    if (spawnListener) {
      child.removeListener('error', spawnListener);
    }
  });
  // A spawn failure may precede the first raced operation.
  void failed.catch(() => undefined);
  child.stderr?.on('data', (data: Buffer) =>
    logger.debug('Launch discovery provider stderr', {
      provider: input.provider,
      data: data.toString(),
    })
  );
  const rejectCallback = (): Promise<never> =>
    Promise.reject(new Error('Launch discovery cannot service provider callbacks'));
  const run = <T>(promise: Promise<T>, description: string, timeoutMs = TIMEOUT_MS) =>
    timeLaunchDiscovery(description, { provider: input.provider, model: input.model }, () =>
      Promise.race([withTimeout({ promise, timeoutMs, description }), failed])
    );
  let sessionId: string | undefined;
  let connection: ReturnType<typeof createAcpConnection> | undefined;
  try {
    if (!(child.stdout && child.stdin)) {
      throw new Error('Launch discovery subprocess stdio unavailable');
    }
    connection = createAcpConnection(
      {
        sessionUpdate: () => Promise.resolve(),
        requestPermission: rejectCallback,
        createElicitation: rejectCallback,
        extNotification: () => Promise.resolve(),
      },
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
    );
    // SDK.closed is logical closure; actual child close remains mandatory.
    retainLifetime(Promise.all([childClosed, connection.closed]).then(() => undefined));

    await run(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'factory-factory', title: 'Factory Factory', version: '1.2.0' },
      }),
      'launch discovery initialize'
    );
    const session = await run(
      connection.newSession({
        cwd,
        mcpServers: [],
        ...(input.provider === 'CLAUDE'
          ? {
              _meta: {
                claudeCode: {
                  options: {
                    persistSession: false,
                    settingSources: ['user'],
                    strictMcpConfig: true,
                    tools: [],
                  },
                },
              },
            }
          : {}),
      }),
      'launch discovery session creation',
      SESSION_CREATION_TIMEOUT_MS
    );
    sessionId = session.sessionId;
    const providerSessionId = sessionId;
    const activeConnection = connection;
    const config = await run(
      applyAcpStartupModel({
        connection,
        provider: input.provider,
        providerSessionId,
        configOptions: requireSessionConfigOptions(input.provider, 'newSession', session),
        model: input.model,
      }),
      'launch discovery model selection'
    );
    const requested = launchOptionsFromConfig(input.provider, config);
    deliver(requested);
    const models = (
      input.selectAdditionalModels?.(
        choices(config.find((option) => option.category === 'model' || option.id === 'model'))
          .map((choice) => choice.value)
          .filter((model) => model !== requested.model)
      ) ?? []
    ).slice(0, MAX_ADDITIONAL_MODELS);
    if (models.length === 0) {
      return [];
    }
    return await timeLaunchDiscovery(
      'launch discovery model sweep',
      { provider: input.provider },
      async () => {
        const captured: NativeSessionLaunchOptions[] = [];
        let current = config;
        for (const model of models) {
          if (input.signal?.aborted) {
            break;
          }
          try {
            current = await Promise.race([
              withTimeout({
                promise: applyAcpStartupModel({
                  connection: activeConnection,
                  provider: input.provider,
                  providerSessionId,
                  configOptions: current,
                  model,
                }),
                timeoutMs: TIMEOUT_MS,
                description: 'launch discovery model sweep',
              }),
              failed,
            ]);
            captured.push(
              withoutThinkingDefaults(launchOptionsFromConfig(input.provider, current))
            );
          } catch {
            // One stalled or rejected model ends the sweep; keep what was captured.
            logger.debug('Launch discovery model sweep stopped', {
              provider: input.provider,
              model,
            });
            break;
          }
        }
        return captured;
      }
    );
  } finally {
    try {
      if (sessionId && connection) {
        try {
          await run(
            connection.extMethod('session/close', { sessionId }),
            'launch discovery close',
            CLOSE_TIMEOUT_MS
          );
        } catch (error) {
          logger.debug('Launch discovery close failed', { provider: input.provider, error });
        }
      }
    } finally {
      try {
        await timeLaunchDiscovery(
          'launch discovery process cleanup',
          { provider: input.provider, model: input.model },
          () => terminateCatalogProcess(child)
        );
      } finally {
        connection?.close();
      }
    }
  }
}
