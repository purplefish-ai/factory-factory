import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import type { NewSessionMeta } from '@agentclientprotocol/claude-agent-acp';
import {
  type Client,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionConfigSelectOption,
} from '@agentclientprotocol/sdk';
import { createLogger, getCurrentProcessEnv } from '@/backend/services/logger.service';
import {
  createAcpSpawnError,
  resolveAcpBinary,
  terminateCatalogProcess,
  withTimeout,
} from './acp-runtime-spawn';
import { formatClaudeModelOptionName } from './claude-model-options';

export type ClaudeModelCatalogEntry = {
  id: string;
  displayName: string;
  description: string | null;
};

const CATALOG_OPERATION_TIMEOUT_MS = 30_000;
const CLAUDE_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp';
const CLAUDE_ACP_BINARY = 'claude-agent-acp';
const appLogger = createLogger('claude-model-catalog-loader');

const unexpectedCallback = (): Promise<never> =>
  Promise.reject(new Error('Claude catalog discovery cannot service ACP callbacks'));

function createCatalogClient(): Client {
  return {
    sessionUpdate: () => Promise.resolve(),
    requestPermission: unexpectedCallback,
    readTextFile: unexpectedCallback,
    writeTextFile: unexpectedCallback,
    extNotification: () => Promise.resolve(),
  };
}

export async function fetchClaudeModelCatalogFromAcp(): Promise<ClaudeModelCatalogEntry[]> {
  const cwd = tmpdir();
  const command = resolveAcpBinary(CLAUDE_ACP_PACKAGE, CLAUDE_ACP_BINARY);
  const child = spawn(command, [], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...getCurrentProcessEnv(),
      BROWSER: 'none',
    },
    detached: false,
  });
  let providerSessionId: string | null = null;
  let spawnErrorListener: ((error: unknown) => void) | null = null;
  const spawnError = new Promise<never>((_resolve, reject) => {
    spawnErrorListener = (error: unknown) => reject(createAcpSpawnError(command, error));
    child.once('error', spawnErrorListener);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    appLogger.debug('Claude ACP catalog stderr', { data: chunk.toString() });
  });

  if (!(child.stdout && child.stdin)) {
    await terminateCatalogProcess(child);
    throw new Error('Claude ACP catalog subprocess stdio streams not available');
  }

  const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const connection = new ClientSideConnection(
    () => createCatalogClient(),
    ndJsonStream(output, input)
  );
  const runOperation = async <T>(promise: Promise<T>, description: string): Promise<T> =>
    await Promise.race([
      withTimeout({
        promise,
        timeoutMs: CATALOG_OPERATION_TIMEOUT_MS,
        description,
      }),
      spawnError,
    ]);

  try {
    await runOperation(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: {
          name: 'factory-factory',
          title: 'Factory Factory',
          version: '1.2.0',
        },
      }),
      'Claude catalog initialize handshake'
    );
    const meta: NewSessionMeta = {
      claudeCode: {
        options: {
          persistSession: false,
          settingSources: ['user'],
          strictMcpConfig: true,
          tools: [],
        },
      },
    };
    const result = await runOperation(
      connection.newSession({
        cwd,
        mcpServers: [],
        _meta: meta,
      }),
      'Claude catalog session creation'
    );
    providerSessionId = result.sessionId;

    const modelOption = result.configOptions
      ?.filter((option) => option.type === 'select')
      .find((option) => option.category === 'model' || option.id === 'model');
    if (!modelOption) {
      throw new Error('Claude ACP session did not provide model options');
    }

    const options = modelOption.options.flatMap((option): SessionConfigSelectOption[] =>
      'group' in option ? option.options : [option]
    );
    if (options.length === 0) {
      throw new Error('Claude ACP session did not provide model options');
    }

    return options.map((option) => ({
      id: option.value,
      displayName: formatClaudeModelOptionName(option),
      description: option.description ?? null,
    }));
  } finally {
    try {
      if (providerSessionId) {
        try {
          await runOperation(
            connection.extMethod('session/close', { sessionId: providerSessionId }),
            'Claude catalog session close'
          );
        } catch (error) {
          appLogger.warn('Failed to close Claude ACP catalog session', { error });
        }
      }
    } finally {
      try {
        await terminateCatalogProcess(child);
      } finally {
        if (spawnErrorListener) {
          child.removeListener('error', spawnErrorListener);
        }
      }
    }
  }
}
