import type {
  AgentSideConnection,
  McpServer,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerAcpAdapter } from './codex-app-server-acp-adapter';
import { CodexRequestError } from './codex-rpc-client';

type MockConnection = Pick<AgentSideConnection, 'closed' | 'sessionUpdate' | 'requestPermission'>;
type InjectedCodexClient = NonNullable<ConstructorParameters<typeof CodexAppServerAcpAdapter>[1]>;
type CodexMocks = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  respondSuccess: ReturnType<typeof vi.fn>;
  respondError: ReturnType<typeof vi.fn>;
};

function createMockConnection(): {
  connection: MockConnection;
  resolveClosed: () => void;
} {
  let resolveClosed: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  return {
    connection: {
      closed,
      sessionUpdate: vi.fn(async () => undefined),
      requestPermission: vi.fn(() => {
        return Promise.resolve({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        } as RequestPermissionResponse);
      }),
    },
    resolveClosed: () => {
      resolveClosed?.();
    },
  };
}

function createMockCodexClient(): { client: InjectedCodexClient; mocks: CodexMocks } {
  const mocks: CodexMocks = {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    request: vi.fn(),
    notify: vi.fn(),
    respondSuccess: vi.fn(),
    respondError: vi.fn(),
  };

  return {
    client: mocks as unknown as InjectedCodexClient,
    mocks,
  };
}

function getCodexRequestCalls(
  codex: CodexMocks,
  method: string
): [string, Record<string, unknown>][] {
  return codex.request.mock.calls.filter(
    (call): call is [string, Record<string, unknown>] => call[0] === method
  );
}

async function initializeAdapterWithDefaultModel(
  adapter: CodexAppServerAcpAdapter,
  codex: CodexMocks
): Promise<void> {
  codex.request.mockResolvedValueOnce({});
  codex.request.mockResolvedValueOnce({
    data: [
      {
        id: 'gpt-5',
        displayName: 'GPT-5',
        description: 'Default model',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [],
        inputModalities: ['text'],
        isDefault: true,
      },
    ],
    nextCursor: null,
  });

  await adapter.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.1' },
  });
}

describe('CodexAppServerAcpAdapter', () => {
  it('paginates model/list during initialize', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    codex.request.mockResolvedValueOnce({});
    codex.request.mockResolvedValueOnce({
      data: [
        {
          id: 'gpt-5-mini',
          displayName: 'GPT-5 Mini',
          description: 'Fast model',
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [],
          inputModalities: ['text'],
          isDefault: false,
        },
      ],
      nextCursor: 'cursor-2',
    });
    codex.request.mockResolvedValueOnce({
      data: [
        {
          id: 'gpt-5',
          displayName: 'GPT-5',
          description: 'Default model',
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [],
          inputModalities: ['text'],
          isDefault: true,
        },
      ],
      nextCursor: null,
    });

    await adapter.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    });

    expect(codex.start).toHaveBeenCalledTimes(1);
    expect(codex.request).toHaveBeenNthCalledWith(2, 'model/list', expect.objectContaining({}));
    expect(codex.request).toHaveBeenNthCalledWith(3, 'model/list', { cursor: 'cursor-2' });
  });

  it('assigns session ids as sess_<threadId> on newSession', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_123', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });

    const response = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    expect(response.sessionId).toBe('sess_thread_123');
  });

  it('writes provided MCP servers to Codex config and reloads on newSession', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_with_mcp', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    codex.request.mockResolvedValueOnce({});
    codex.request.mockResolvedValueOnce({});

    const mcpServers: McpServer[] = [
      {
        name: 'local-tools',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/workspace'],
        env: [{ name: 'NODE_ENV', value: 'test' }],
      },
    ];

    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers,
    });

    expect(getCodexRequestCalls(codex, 'config/value/write')).toEqual([
      [
        'config/value/write',
        {
          keyPath: 'mcp_servers',
          mergeStrategy: 'replace',
          value: {
            'local-tools': {
              enabled: true,
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/workspace'],
              env: { NODE_ENV: 'test' },
            },
          },
        },
      ],
    ]);
    expect(getCodexRequestCalls(codex, 'config/mcpServer/reload')).toEqual([
      ['config/mcpServer/reload', {}],
    ]);
  });

  it('deduplicates MCP server names when writing Codex config', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_mcp_names', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    codex.request.mockResolvedValueOnce({});
    codex.request.mockResolvedValueOnce({});

    const mcpServers: McpServer[] = [
      { name: '', command: 'server-a', args: [], env: [] },
      { name: 'dup', command: 'server-b', args: [], env: [] },
      { name: 'dup', command: 'server-c', args: [], env: [] },
    ];

    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers,
    });

    const configWriteCalls = getCodexRequestCalls(codex, 'config/value/write');
    expect(configWriteCalls).toHaveLength(1);
    const firstWriteCall = configWriteCalls[0];
    if (!firstWriteCall) {
      throw new Error('expected config/value/write call');
    }
    expect(firstWriteCall[1]).toEqual({
      keyPath: 'mcp_servers',
      mergeStrategy: 'replace',
      value: {
        mcp_server_1: { enabled: true, command: 'server-a', args: [] },
        dup: { enabled: true, command: 'server-b', args: [] },
        dup_2: { enabled: true, command: 'server-c', args: [] },
      },
    });
  });

  it('does not keep a session when MCP config write fails during newSession', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_mcp_error', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    codex.request.mockRejectedValueOnce(new Error('failed to write codex config'));

    await expect(
      adapter.newSession({
        cwd: '/tmp/workspace',
        mcpServers: [{ name: 'broken', command: 'bad-server', args: [], env: [] }],
      })
    ).rejects.toThrow('failed to write codex config');

    await expect(
      adapter.setSessionConfigOption({
        sessionId: 'sess_thread_mcp_error',
        configId: 'mode',
        value: 'code',
      })
    ).rejects.toBeInstanceOf(Error);
  });

  it('loadSession replays thread history from thread/read', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_abc', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    codex.request.mockResolvedValueOnce({
      thread: {
        id: 'thread_abc',
        turns: [
          {
            id: 'turn_1',
            items: [
              {
                type: 'userMessage',
                id: 'item_u1',
                content: [{ type: 'text', text: 'hello' }],
              },
              {
                type: 'agentMessage',
                id: 'item_a1',
                text: 'hi',
              },
              {
                type: 'commandExecution',
                id: 'item_c1',
                command: 'pwd',
              },
            ],
          },
        ],
      },
    });

    await adapter.loadSession({
      sessionId: 'sess_thread_abc',
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    const updates = (connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].update
    );
    expect(updates.some((update) => update.sessionUpdate === 'user_message_chunk')).toBe(true);
    expect(updates.some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(true);
    expect(
      updates.some(
        (update) =>
          update.sessionUpdate === 'tool_call' &&
          update.status === 'completed' &&
          update.toolCallId === 'codex:thread_abc:turn_1:item_c1'
      )
    ).toBe(true);
  });

  it('writes provided MCP servers to Codex config and reloads on loadSession', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_resume', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    codex.request.mockResolvedValueOnce({});
    codex.request.mockResolvedValueOnce({});
    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_resume', turns: [] },
    });

    const mcpServers: McpServer[] = [
      {
        type: 'http',
        name: 'remote-tools',
        url: 'https://mcp.example.com',
        headers: [{ name: 'Authorization', value: 'Bearer token' }],
      },
    ];

    await adapter.loadSession({
      sessionId: 'sess_thread_resume',
      cwd: '/tmp/workspace',
      mcpServers,
    });

    expect(getCodexRequestCalls(codex, 'config/value/write')).toEqual([
      [
        'config/value/write',
        {
          keyPath: 'mcp_servers',
          mergeStrategy: 'replace',
          value: {
            'remote-tools': {
              enabled: true,
              url: 'https://mcp.example.com',
              http_headers: {
                Authorization: 'Bearer token',
              },
            },
          },
        },
      ],
    ]);
    expect(getCodexRequestCalls(codex, 'config/mcpServer/reload')).toEqual([
      ['config/mcpServer/reload', {}],
    ]);
  });

  it('rejects invalid thought level values', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_123', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await expect(
      adapter.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'reasoning_effort',
        value: 'turbo',
      })
    ).rejects.toBeInstanceOf(Error);
  });

  it('maps tool request_user_input selections into answer payloads', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'answer_1' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_perm', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await (
      adapter as unknown as {
        handleCodexServerRequest: (request: unknown) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: 17,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread_perm',
        turnId: 'turn_perm',
        itemId: 'item_perm',
        questions: [
          {
            id: 'choice',
            header: 'Pick one',
            question: 'Select an option',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'First', description: 'One' },
              { label: 'Second', description: 'Two' },
            ],
          },
        ],
      },
    });

    expect(codex.respondSuccess).toHaveBeenCalledWith(17, {
      answers: {
        choice: { answers: ['Second'] },
      },
    });
  });

  it('treats cancelled request_user_input permission outcomes as rejected', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: { outcome: 'cancelled' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_cancelled_input', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await (
      adapter as unknown as {
        handleCodexServerRequest: (request: unknown) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: 21,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread_cancelled_input',
        turnId: 'turn_cancelled_input',
        itemId: 'item_cancelled_input',
        questions: [
          {
            id: 'choice',
            header: 'Pick one',
            question: 'Select an option',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'First', description: 'One' },
              { label: 'Second', description: 'Two' },
            ],
          },
        ],
      },
    });

    expect(codex.respondSuccess).toHaveBeenCalledWith(21, {
      answers: {},
    });
    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              status: 'failed',
              rawOutput: 'User denied tool input request',
            }),
          }),
        ],
      ])
    );
  });

  it('stops codex subprocess when ACP connection closes', async () => {
    const { connection, resolveClosed } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    resolveClosed();
    await Promise.resolve();
    await Promise.resolve();

    expect(codex.stop).toHaveBeenCalledTimes(1);
  });

  it('does not access connection.closed synchronously during constructor', async () => {
    let allowClosedRead = false;
    const closedPromise = Promise.resolve();
    const connection = {
      get closed() {
        if (!allowClosedRead) {
          throw new Error('closed accessed too early');
        }
        return closedPromise;
      },
      sessionUpdate: vi.fn(async () => undefined),
      requestPermission: vi.fn(() =>
        Promise.resolve({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        } as RequestPermissionResponse)
      ),
    };
    const { client: codexClient, mocks: codex } = createMockCodexClient();

    expect(() => {
      new CodexAppServerAcpAdapter(connection as unknown as AgentSideConnection, codexClient);
    }).not.toThrow();

    allowClosedRead = true;
    await Promise.resolve();
    await Promise.resolve();
    expect(codex.stop).toHaveBeenCalledTimes(1);
  });

  it('returns end_turn on overloaded turn/start and emits fallback message', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_overload', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    codex.request.mockRejectedValueOnce(
      new CodexRequestError({
        code: -32_001,
        message: 'Server overloaded; retry later.',
      })
    );

    const response = await adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(response.stopReason).toBe('end_turn');
    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'agent_message_chunk',
            }),
          }),
        ],
      ])
    );
  });

  it('cancel interrupts active turn and resolves prompt with cancelled', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_cancel', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    codex.request.mockResolvedValueOnce({
      turn: { id: 'turn_cancel', status: 'inProgress' },
    });
    codex.request.mockResolvedValueOnce({});

    const promptPromise = adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await vi.waitFor(() => {
      expect(codex.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({ threadId: 'thread_cancel' })
      );
    });
    await adapter.cancel({ sessionId: session.sessionId });

    expect(codex.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread_cancel',
      turnId: 'turn_cancel',
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('turn/completed', {
      threadId: 'thread_cancel',
      turn: { id: 'turn_cancel', status: 'interrupted', error: null, items: [] },
    });

    await expect(promptPromise).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('declines command approvals when permission is rejected', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'reject_once' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_decline', cwd: '/tmp/workspace' },
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await (
      adapter as unknown as {
        handleCodexServerRequest: (request: unknown) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: 18,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_decline',
        turnId: 'turn_decline',
        itemId: 'item_decline',
        command: 'rm -rf tmp',
      },
    });

    expect(codex.respondSuccess).toHaveBeenCalledWith(18, { decision: 'decline' });
    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              status: 'failed',
            }),
          }),
        ],
      ])
    );
  });
});
