import { tmpdir } from 'node:os';
import { ClaudeAcpAgent, type NewSessionMeta } from '@agentclientprotocol/claude-agent-acp';
import { PROTOCOL_VERSION, type SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import { createLogger } from '@/backend/services/logger.service';
import { formatClaudeModelOptionName } from './claude-model-options';

export type ClaudeModelCatalogEntry = {
  id: string;
  displayName: string;
  description: string | null;
};

const appLogger = createLogger('claude-model-catalog-loader');

const claudeLogger: NonNullable<ConstructorParameters<typeof ClaudeAcpAgent>[1]> = {
  log: (...args: unknown[]) => appLogger.debug('Claude ACP catalog', { args }),
  error: (...args: unknown[]) => appLogger.warn('Claude ACP catalog', { args }),
};

const noOp = (): Promise<void> => Promise.resolve();

const unexpectedCallback = (): Promise<never> =>
  Promise.reject(new Error('Claude catalog discovery cannot service ACP callbacks'));

function createCatalogClient(): ConstructorParameters<typeof ClaudeAcpAgent>[0] {
  return {
    sessionUpdate: noOp,
    extNotification: noOp,
    unstable_completeElicitation: noOp,
    requestPermission: unexpectedCallback,
    readTextFile: unexpectedCallback,
    writeTextFile: unexpectedCallback,
    unstable_createElicitation: unexpectedCallback,
  };
}

export async function fetchClaudeModelCatalogFromAcp(): Promise<ClaudeModelCatalogEntry[]> {
  const agent = new ClaudeAcpAgent(createCatalogClient(), claudeLogger);
  let providerSessionId: string | null = null;

  try {
    await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const meta: NewSessionMeta = {
      claudeCode: {
        options: {
          persistSession: false,
          settingSources: ['user'],
          tools: [],
        },
      },
    };
    const result = await agent.newSession({
      cwd: tmpdir(),
      mcpServers: [],
      _meta: meta,
    });
    providerSessionId = result.sessionId;

    const modelOption = result.configOptions
      ?.filter((option) => option.type === 'select')
      .find((option) => option.category === 'model');
    if (!modelOption) {
      throw new Error('Claude ACP session did not provide model options');
    }

    const options = modelOption.options.filter(
      (option): option is SessionConfigSelectOption => 'value' in option
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
        await agent.closeSession({ sessionId: providerSessionId });
      }
    } finally {
      await agent.dispose();
    }
  }
}
