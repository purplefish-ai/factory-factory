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
const CLOSE_TIMEOUT_MS = 1000;
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
/** Disposable native configuration discovery. No prompt is submitted. */
export async function fetchSessionLaunchOptionsFromAcp(input: {
  provider: 'CLAUDE' | 'CODEX';
  model?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<NativeSessionLaunchOptions> {
  const command = resolveProviderAcpSpawnCommand(input.provider);
  const cwd = tmpdir();
  const child = spawn(command.command, command.args, {
    cwd,
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
  let spawnListener: ((error: Error) => void) | undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    spawnListener = (error) => reject(createAcpSpawnError(command.commandLabel, error));
    child.once('error', spawnListener);
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
    Promise.race([withTimeout({ promise, timeoutMs, description }), failed]);
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
      'launch discovery session creation'
    );
    sessionId = session.sessionId;
    const config = await run(
      applyAcpStartupModel({
        connection,
        provider: input.provider,
        providerSessionId: sessionId,
        configOptions: requireSessionConfigOptions(input.provider, 'newSession', session),
        model: input.model,
      }),
      'launch discovery model selection'
    );
    return launchOptionsFromConfig(input.provider, config);
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
        await terminateCatalogProcess(child);
      } finally {
        try {
          connection?.close();
        } finally {
          if (spawnListener) {
            child.removeListener('error', spawnListener);
          }
        }
      }
    }
  }
}
