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

const DEFAULT_APPROVAL_POLICY = 'on-failure';
const DEFAULT_ALLOWED_APPROVAL_POLICIES = [DEFAULT_APPROVAL_POLICY, 'on-request', 'never'];
const DEFAULT_ALLOWED_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const DEFAULT_COLLABORATION_MODES = [
  { name: 'Default', mode: 'default' },
  { name: 'Plan', mode: 'plan' },
];

async function initializeAdapterWithDefaultModel(
  adapter: CodexAppServerAcpAdapter,
  codex: CodexMocks,
  options?: {
    collaborationModes?: Array<{ name: string; mode: string }>;
  }
): Promise<void> {
  codex.request.mockResolvedValueOnce({});
  codex.request.mockResolvedValueOnce({
    requirements: {
      allowedApprovalPolicies: DEFAULT_ALLOWED_APPROVAL_POLICIES,
      allowedSandboxModes: DEFAULT_ALLOWED_SANDBOX_MODES,
    },
  });
  codex.request.mockResolvedValueOnce({
    data: options?.collaborationModes ?? DEFAULT_COLLABORATION_MODES,
    nextCursor: null,
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
}

describe('CodexAppServerAcpAdapter', () => {
  it('paginates model/list during initialize', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    codex.request.mockResolvedValueOnce({});
    codex.request.mockResolvedValueOnce({
      requirements: {
        allowedApprovalPolicies: DEFAULT_ALLOWED_APPROVAL_POLICIES,
        allowedSandboxModes: DEFAULT_ALLOWED_SANDBOX_MODES,
      },
    });
    codex.request.mockResolvedValueOnce({
      data: DEFAULT_COLLABORATION_MODES,
      nextCursor: null,
    });
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
    expect(codex.request).toHaveBeenNthCalledWith(2, 'configRequirements/read', undefined);
    expect(codex.request).toHaveBeenNthCalledWith(3, 'collaborationMode/list', {});
    expect(codex.request).toHaveBeenNthCalledWith(4, 'model/list', expect.objectContaining({}));
    expect(codex.request).toHaveBeenNthCalledWith(5, 'model/list', { cursor: 'cursor-2' });
  });

  it('assigns session ids as sess_<threadId> on newSession', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_123', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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

  it('keeps existing MCP server config when a subsequent session has no MCP servers', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_with_mcp_then_clear', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    codex.request.mockResolvedValueOnce({});
    codex.request.mockResolvedValueOnce({});

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_without_mcp', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    codex.request.mockResolvedValueOnce({});
    codex.request.mockResolvedValueOnce({});

    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [{ name: 'tools', command: 'server-a', args: [], env: [] }],
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    const configWriteCalls = getCodexRequestCalls(codex, 'config/value/write');
    expect(configWriteCalls).toHaveLength(1);
    expect(configWriteCalls[0]).toEqual([
      'config/value/write',
      {
        keyPath: 'mcp_servers',
        mergeStrategy: 'replace',
        value: {
          tools: {
            enabled: true,
            command: 'server-a',
            args: [],
          },
        },
      },
    ]);
  });

  it('loadSession replays thread history from thread/read', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_abc', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
              {
                type: 'reasoning',
                id: 'item_r1',
                summary: [{ type: 'summary_text', text: '**Thinking through replay**' }],
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
          update.sessionUpdate === 'agent_thought_chunk' &&
          update.content?.type === 'text' &&
          update.content.text === '**Thinking through replay**'
      )
    ).toBe(true);
    expect(
      updates.some(
        (update) =>
          update.sessionUpdate === 'tool_call' &&
          update.status === 'completed' &&
          update.toolCallId === 'item_c1'
      )
    ).toBe(true);
  });

  it('does not duplicate replayed tool and reasoning updates when matching live events arrive', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_replay_dedupe', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    codex.request.mockResolvedValueOnce({
      thread: {
        id: 'thread_replay_dedupe',
        turns: [
          {
            id: 'turn_replay_dedupe',
            items: [
              {
                type: 'commandExecution',
                id: 'item_replayed_command',
                command: 'cat README.md',
              },
              {
                type: 'reasoning',
                id: 'item_replayed_reasoning',
                summary: [{ type: 'summary_text', text: '**From replay**' }],
              },
            ],
          },
        ],
      },
    });

    await adapter.loadSession({
      sessionId: 'sess_thread_replay_dedupe',
      cwd: '/tmp/workspace',
      mcpServers: [],
    });
    (connection.sessionUpdate as ReturnType<typeof vi.fn>).mockClear();

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_replay_dedupe',
      turnId: 'turn_replay_dedupe',
      item: {
        type: 'commandExecution',
        id: 'item_replayed_command',
        status: 'inProgress',
        command: 'cat README.md',
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_replay_dedupe',
      turnId: 'turn_replay_dedupe',
      item: {
        type: 'commandExecution',
        id: 'item_replayed_command',
        status: 'completed',
        command: 'cat README.md',
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/reasoning/summaryTextDelta', {
      threadId: 'thread_replay_dedupe',
      turnId: 'turn_replay_dedupe',
      itemId: 'item_replayed_reasoning',
      delta: '**From live**',
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_replay_dedupe',
      turnId: 'turn_replay_dedupe',
      item: {
        type: 'reasoning',
        id: 'item_replayed_reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text: '**From live**' }],
      },
    });

    expect(connection.sessionUpdate).not.toHaveBeenCalled();
  });

  it('prefers codex callId for tool call ids and enriches command metadata', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_call_id', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_call_id',
      turnId: 'turn_call_id',
      item: {
        type: 'commandExecution',
        id: 'item_call_id',
        callId: 'call_123',
        status: 'inProgress',
        command: 'cat README.md',
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_call_id',
      turnId: 'turn_call_id',
      item: {
        type: 'commandExecution',
        id: 'item_call_id',
        callId: 'call_123',
        status: 'completed',
        command: 'cat README.md',
      },
    });

    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call',
              toolCallId: 'call_123',
              title: 'Read README.md',
              kind: 'read',
              locations: [{ path: '/tmp/workspace/README.md' }],
            }),
          }),
        ],
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call_123',
              title: 'Read README.md',
              kind: 'read',
            }),
          }),
        ],
      ])
    );
  });

  it('parses escaped quotes in quoted command arguments for metadata', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_escaped_quotes', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_escaped_quotes',
      turnId: 'turn_escaped_quotes',
      item: {
        type: 'commandExecution',
        id: 'item_escaped_quotes',
        status: 'inProgress',
        command: 'cat "nested \\"quotes\\".md"',
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_escaped_quotes',
      turnId: 'turn_escaped_quotes',
      item: {
        type: 'commandExecution',
        id: 'item_escaped_quotes',
        status: 'completed',
        command: 'cat "nested \\"quotes\\".md"',
      },
    });

    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call',
              title: 'Read nested "quotes".md',
              kind: 'read',
              locations: [{ path: '/tmp/workspace/nested "quotes".md' }],
            }),
          }),
        ],
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              title: 'Read nested "quotes".md',
              kind: 'read',
              locations: [{ path: '/tmp/workspace/nested "quotes".md' }],
            }),
          }),
        ],
      ])
    );
  });

  it('parses escaped single quotes and escaped spaces in command metadata', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_escaped_single_quotes', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_escaped_single_quotes',
      turnId: 'turn_escaped_single_quotes',
      item: {
        type: 'commandExecution',
        id: 'item_escaped_single_quotes',
        status: 'inProgress',
        command: "cat 'it\\'s file.txt'",
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_escaped_single_quotes',
      turnId: 'turn_escaped_single_quotes',
      item: {
        type: 'commandExecution',
        id: 'item_escaped_single_quotes',
        status: 'completed',
        command: "cat 'it\\'s file.txt'",
      },
    });

    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call',
              title: "Read it's file.txt",
              kind: 'read',
              locations: [{ path: "/tmp/workspace/it's file.txt" }],
            }),
          }),
        ],
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              title: "Read it's file.txt",
              kind: 'read',
              locations: [{ path: "/tmp/workspace/it's file.txt" }],
            }),
          }),
        ],
      ])
    );
  });

  it('derives command metadata from actionable chained subcommands', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_chained_command', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_chained_command',
      turnId: 'turn_chained_command',
      item: {
        type: 'commandExecution',
        id: 'item_chained_command',
        status: 'inProgress',
        command: 'cd src && rg "TODO" README.md',
      },
    });

    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call',
              title: 'Search TODO in README.md',
              kind: 'search',
              locations: [{ path: '/tmp/workspace/README.md' }],
            }),
          }),
        ],
      ])
    );
  });

  it('keeps escaped apostrophes inside single quotes when splitting chained commands', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_chain_single_quote_escape', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_chain_single_quote_escape',
      turnId: 'turn_chain_single_quote_escape',
      item: {
        type: 'commandExecution',
        id: 'item_chain_single_quote_escape',
        status: 'inProgress',
        command: "cat 'it\\'s file.txt' && rg TODO README.md",
      },
    });

    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call',
              title: "Read it's file.txt, Search TODO in README.md",
              kind: 'read',
              locations: [
                { path: "/tmp/workspace/it's file.txt" },
                { path: '/tmp/workspace/README.md' },
              ],
            }),
          }),
        ],
      ])
    );
  });

  it('avoids duplicate thought chunks when reasoning started item already contains summary text', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_reasoning', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_reasoning',
      turnId: 'turn_reasoning',
      item: {
        type: 'reasoning',
        id: 'item_reasoning',
        status: 'inProgress',
        summary: [{ type: 'summary_text', text: '**Analyzing approach**' }],
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/reasoning/summaryTextDelta', {
      threadId: 'thread_reasoning',
      turnId: 'turn_reasoning',
      itemId: 'item_reasoning',
      delta: '**Analyzing approach**',
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_reasoning',
      turnId: 'turn_reasoning',
      item: {
        type: 'reasoning',
        id: 'item_reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text: '**Analyzing approach**' }],
      },
    });

    const updates = (connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].update
    );
    const thoughtChunks = updates.filter(
      (update) => update.sessionUpdate === 'agent_thought_chunk'
    );
    expect(thoughtChunks).toEqual([
      {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '**Analyzing approach**' },
      },
    ]);
    expect(
      updates.some(
        (update) =>
          update.sessionUpdate === 'tool_call' &&
          update.toolCallId === 'item_reasoning' &&
          update.kind === 'think' &&
          update.status === 'pending'
      )
    ).toBe(true);
    expect(
      updates.some(
        (update) =>
          update.sessionUpdate === 'tool_call_update' &&
          update.toolCallId === 'item_reasoning' &&
          update.status === 'in_progress'
      )
    ).toBe(true);
    expect(
      updates.some(
        (update) =>
          update.sessionUpdate === 'tool_call_update' &&
          update.toolCallId === 'item_reasoning' &&
          update.status === 'completed'
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
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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

  it('falls back to default execution presets when config requirements are missing', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    codex.request.mockResolvedValueOnce({});
    codex.request.mockResolvedValueOnce({
      requirements: null,
    });
    codex.request.mockResolvedValueOnce({
      data: DEFAULT_COLLABORATION_MODES,
      nextCursor: null,
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

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_defaults', cwd: '/tmp/workspace' },
      approvalPolicy: 'on-request',
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/workspace'],
        readOnlyAccess: { type: 'fullAccess' },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      reasoningEffort: 'medium',
    });

    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    const executionModeOption = (session.configOptions ?? []).find(
      (option) => option.id === 'execution_mode'
    );
    expect(executionModeOption?.type).toBe('select');
    if (executionModeOption?.type !== 'select') {
      throw new Error('expected execution_mode select option');
    }

    const presetValues = executionModeOption.options.flatMap((option) =>
      'value' in option ? [option.value] : []
    );
    const presetEntries = executionModeOption.options.flatMap((option) =>
      'value' in option ? [option] : []
    );

    expect(presetValues.length).toBeGreaterThan(1);
    expect(presetValues).toContain(JSON.stringify(['never', 'danger-full-access']));
    expect(presetValues).toContain(JSON.stringify(['on-failure', 'workspace-write']));
    expect(presetEntries).toContainEqual(
      expect.objectContaining({
        value: JSON.stringify(['never', 'danger-full-access']),
        name: 'YOLO (Full Access)',
      })
    );
    expect(presetEntries).toContainEqual(
      expect.objectContaining({
        value: JSON.stringify(['on-request', 'workspace-write']),
        name: 'On Request (Workspace Write)',
      })
    );
  });

  it('applies discovered execution mode and plan collaboration mode to turn/start', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_modes', cwd: '/tmp/workspace' },
      approvalPolicy: 'on-request',
      sandbox: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/workspace'],
        readOnlyAccess: { type: 'fullAccess' },
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });
    const executionModeOption = (session.configOptions ?? []).find(
      (option) => option.id === 'execution_mode'
    );
    const yoloLikeOption =
      executionModeOption?.type === 'select'
        ? executionModeOption.options.find(
            (option): option is { value: string; name: string; description?: string } =>
              'value' in option &&
              option.value.includes('never') &&
              option.value.includes('danger-full-access')
          )
        : null;
    expect(yoloLikeOption).toBeDefined();
    if (!yoloLikeOption) {
      throw new Error('expected discovered execution mode option');
    }

    await adapter.setSessionMode({ sessionId: session.sessionId, modeId: 'plan' });
    await adapter.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: 'execution_mode',
      value: yoloLikeOption.value,
    });

    codex.request.mockResolvedValueOnce({
      turn: { id: 'turn_modes', status: 'completed' },
    });

    const promptResponse = await adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(promptResponse.stopReason).toBe('end_turn');
    expect(codex.request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        threadId: 'thread_modes',
        approvalPolicy: 'never',
        sandboxPolicy: expect.objectContaining({ type: 'dangerFullAccess' }),
        collaborationMode: expect.objectContaining({
          mode: 'plan',
        }),
      })
    );
  });

  it('rejects empty prompt content and does not start a turn', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_empty_prompt', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await expect(
      adapter.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '   ' }],
      })
    ).rejects.toBeInstanceOf(Error);

    expect(getCodexRequestCalls(codex, 'turn/start')).toHaveLength(0);

    codex.request.mockResolvedValueOnce({
      turn: { id: 'turn_after_empty_prompt', status: 'completed' },
    });
    await expect(
      adapter.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'run now' }],
      })
    ).resolves.toEqual({ stopReason: 'end_turn' });

    expect(getCodexRequestCalls(codex, 'turn/start')).toHaveLength(1);
  });

  it('requests ExitPlanMode approval after completed plan item in plan mode', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'default' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_plan_approval', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });
    await adapter.setSessionMode({ sessionId: session.sessionId, modeId: 'plan' });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_plan_approval',
      turnId: 'turn_plan_approval',
      item: {
        type: 'plan',
        id: 'item_plan_approval',
        status: 'inProgress',
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/plan/delta', {
      threadId: 'thread_plan_approval',
      turnId: 'turn_plan_approval',
      itemId: 'item_plan_approval',
      delta: '## Proposed Plan\n1. Add adapter plan approval bridge',
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_plan_approval',
      turnId: 'turn_plan_approval',
      item: {
        type: 'plan',
        id: 'item_plan_approval',
        status: 'completed',
      },
    });

    expect(connection.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({
          title: 'ExitPlanMode',
          kind: 'switch_mode',
        }),
        options: [
          { optionId: 'default', name: 'Approve and switch to Default', kind: 'allow_once' },
          { optionId: 'plan', name: 'Keep planning', kind: 'reject_once' },
        ],
      })
    );
    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call',
              title: 'ExitPlanMode',
              kind: 'switch_mode',
              status: 'pending',
              rawInput: expect.objectContaining({
                type: 'ExitPlanMode',
                plan: expect.objectContaining({
                  type: 'text',
                  text: expect.stringContaining('## Proposed Plan'),
                }),
              }),
            }),
          }),
        ],
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'config_option_update',
              configOptions: expect.arrayContaining([
                expect.objectContaining({
                  id: 'mode',
                  currentValue: 'default',
                }),
              ]),
            }),
          }),
        ],
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              title: 'ExitPlanMode',
              kind: 'switch_mode',
              status: 'completed',
            }),
          }),
        ],
      ])
    );
  });

  it('switches to the selected non-plan mode id when plan approval is accepted', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'code' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex, {
      collaborationModes: [
        { name: 'Default', mode: 'default' },
        { name: 'Code', mode: 'code' },
        { name: 'Plan', mode: 'plan' },
      ],
    });

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_plan_mode_switch', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });
    await adapter.setSessionMode({ sessionId: session.sessionId, modeId: 'plan' });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_plan_mode_switch',
      turnId: 'turn_plan_mode_switch',
      item: {
        type: 'plan',
        id: 'item_plan_mode_switch',
        status: 'inProgress',
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/plan/delta', {
      threadId: 'thread_plan_mode_switch',
      turnId: 'turn_plan_mode_switch',
      itemId: 'item_plan_mode_switch',
      delta: '# Plan\n- implement this',
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_plan_mode_switch',
      turnId: 'turn_plan_mode_switch',
      item: {
        type: 'plan',
        id: 'item_plan_mode_switch',
        status: 'completed',
      },
    });

    expect(connection.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({ optionId: 'default', kind: 'allow_once' }),
          expect.objectContaining({ optionId: 'code', kind: 'allow_once' }),
          expect.objectContaining({ optionId: 'plan', kind: 'reject_once' }),
        ]),
      })
    );

    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'config_option_update',
              configOptions: expect.arrayContaining([
                expect.objectContaining({
                  id: 'mode',
                  currentValue: 'code',
                }),
              ]),
            }),
          }),
        ],
      ])
    );
  });

  it('holds prompt completion until plan approval resolves and exits plan mode', async () => {
    let resolvePlanApproval: (value: RequestPermissionResponse) => void = () => {
      throw new Error('expected plan approval request callback');
    };
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<RequestPermissionResponse>((resolve) => {
          resolvePlanApproval = resolve;
        })
    );

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_plan_hold', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });
    await adapter.setSessionMode({ sessionId: session.sessionId, modeId: 'plan' });

    codex.request.mockResolvedValueOnce({
      turn: { id: 'turn_plan_hold', status: 'inProgress' },
    });

    const promptPromise = adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'continue' }],
    });

    await vi.waitFor(() => {
      expect(codex.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({
          threadId: 'thread_plan_hold',
        })
      );
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_plan_hold',
      turnId: 'turn_plan_hold',
      item: {
        type: 'plan',
        id: 'item_plan_hold',
        status: 'inProgress',
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/plan/delta', {
      threadId: 'thread_plan_hold',
      turnId: 'turn_plan_hold',
      itemId: 'item_plan_hold',
      delta: '# Plan\n- implement it',
    });

    const itemCompletedPromise = (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_plan_hold',
      turnId: 'turn_plan_hold',
      item: {
        type: 'plan',
        id: 'item_plan_hold',
        status: 'completed',
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('turn/completed', {
      threadId: 'thread_plan_hold',
      turn: { id: 'turn_plan_hold', status: 'completed', error: null, items: [] },
    });

    let promptSettled = false;
    void promptPromise.then(() => {
      promptSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptSettled).toBe(false);

    resolvePlanApproval({
      outcome: { outcome: 'selected', optionId: 'default' },
    });

    await itemCompletedPromise;
    await expect(promptPromise).resolves.toEqual({ stopReason: 'end_turn' });

    codex.request.mockResolvedValueOnce({
      turn: { id: 'turn_after_plan_hold', status: 'completed' },
    });

    const secondPrompt = await adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'implement now' }],
    });

    expect(secondPrompt.stopReason).toBe('end_turn');
    const turnStartCalls = getCodexRequestCalls(codex, 'turn/start');
    const secondTurnStart = turnStartCalls[1]?.[1];
    expect(secondTurnStart).toBeDefined();
    expect(secondTurnStart).toEqual(
      expect.objectContaining({
        collaborationMode: expect.objectContaining({
          mode: 'default',
        }),
      })
    );
  });

  it('marks synthetic ExitPlanMode approval as failed when user rejects', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'plan' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_plan_reject', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });
    await adapter.setSessionMode({ sessionId: session.sessionId, modeId: 'plan' });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_plan_reject',
      turnId: 'turn_plan_reject',
      item: {
        type: 'plan',
        id: 'item_plan_reject',
        status: 'inProgress',
      },
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/plan/delta', {
      threadId: 'thread_plan_reject',
      turnId: 'turn_plan_reject',
      itemId: 'item_plan_reject',
      delta: '# Plan\n- gather context',
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/completed', {
      threadId: 'thread_plan_reject',
      turnId: 'turn_plan_reject',
      item: {
        type: 'plan',
        id: 'item_plan_reject',
        status: 'completed',
      },
    });

    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              title: 'ExitPlanMode',
              kind: 'switch_mode',
              status: 'failed',
              rawOutput: 'Plan approval rejected',
            }),
          }),
        ],
      ])
    );
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
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
    expect(connection.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({
          title: 'item/tool/requestUserInput',
        }),
      })
    );
    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              status: 'completed',
            }),
          }),
        ],
      ])
    );
  });

  it('maps multi-question request_user_input answers from ACP _meta payload', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      _meta: {
        factoryFactory: {
          toolUserInputAnswers: {
            color: ['Blue'],
            shell: ['zsh', 'fish'],
            unknown: ['ignored'],
          },
        },
      },
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_multi_question', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
      id: 19,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread_multi_question',
        turnId: 'turn_multi_question',
        itemId: 'item_multi_question',
        questions: [
          {
            id: 'color',
            header: 'Pick color',
            question: 'Favorite color?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Blue', description: 'cool' }],
          },
          {
            id: 'shell',
            header: 'Pick shells',
            question: 'Preferred shells?',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'zsh', description: 'default' },
              { label: 'fish', description: 'friendly' },
            ],
          },
        ],
      },
    });

    expect(codex.respondSuccess).toHaveBeenCalledWith(19, {
      answers: {
        color: { answers: ['Blue'] },
        shell: { answers: ['zsh', 'fish'] },
      },
    });
    expect(connection.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          { optionId: 'allow_once', name: 'Submit', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Cancel', kind: 'reject_once' },
        ],
      })
    );
  });

  it('fails multi-question request_user_input when structured answers are missing', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'answer_1' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_multi_question_no_meta', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
      id: 20,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread_multi_question_no_meta',
        turnId: 'turn_multi_question_no_meta',
        itemId: 'item_multi_question_no_meta',
        questions: [
          {
            id: 'color',
            header: 'Pick color',
            question: 'Favorite color?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Blue', description: 'cool' }],
          },
          {
            id: 'shell',
            header: 'Pick shells',
            question: 'Preferred shells?',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'zsh', description: 'default' },
              { label: 'fish', description: 'friendly' },
            ],
          },
        ],
      },
    });

    expect(codex.respondError).toHaveBeenCalledWith(
      20,
      expect.objectContaining({
        message: 'Failed to map requestUserInput answers',
      })
    );
    expect((connection.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              status: 'failed',
              rawOutput: expect.objectContaining({
                error: 'Missing structured answers for multi-question requestUserInput',
              }),
            }),
          }),
        ],
      ])
    );
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
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
              rawOutput: { outcome: 'rejected' },
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(codex.stop).toHaveBeenCalledTimes(1);
  });

  it('retries closed watcher registration when closed getter is not ready', async () => {
    let closedReadCount = 0;
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = () => resolve();
    });
    const connection = {
      get closed() {
        closedReadCount += 1;
        if (closedReadCount === 1) {
          throw new Error('closed not ready yet');
        }
        return closed;
      },
      sessionUpdate: vi.fn(async () => undefined),
      requestPermission: vi.fn(() =>
        Promise.resolve({
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        } as RequestPermissionResponse)
      ),
    };
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    new CodexAppServerAcpAdapter(connection as unknown as AgentSideConnection, codexClient);

    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    resolveClosed?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(closedReadCount).toBeGreaterThanOrEqual(2);
    expect(codex.stop).toHaveBeenCalledTimes(1);
  });

  it('stops retrying close watcher registration after retry limit', async () => {
    vi.useFakeTimers();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const connection = {
        get closed() {
          throw new Error('closed never ready');
        },
        sessionUpdate: vi.fn(async () => undefined),
        requestPermission: vi.fn(() =>
          Promise.resolve({
            outcome: { outcome: 'selected', optionId: 'allow_once' },
          } as RequestPermissionResponse)
        ),
      };
      const { client: codexClient, mocks: codex } = createMockCodexClient();
      new CodexAppServerAcpAdapter(connection as unknown as AgentSideConnection, codexClient);

      await vi.runAllTimersAsync();

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to attach close watcher after 50 attempts')
      );
      expect(codex.stop).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('returns end_turn on overloaded turn/start and emits fallback message', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_overload', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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

  it('queues early cancel until turn id is known, then interrupts the turn', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_early_cancel', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    let resolveTurnStart:
      | ((value: { turn: { id: string; status: 'inProgress' } }) => void)
      | undefined;
    codex.request.mockImplementationOnce(
      async (method: string): Promise<{ turn: { id: string; status: 'inProgress' } }> => {
        if (method !== 'turn/start') {
          return { turn: { id: 'unexpected', status: 'inProgress' } };
        }
        return await new Promise((resolve) => {
          resolveTurnStart = resolve;
        });
      }
    );

    const promptPromise = adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    await vi.waitFor(() => {
      const activeTurn = (
        adapter as unknown as {
          sessions: Map<string, { activeTurn: { turnId: string } | null }>;
        }
      ).sessions.get(session.sessionId)?.activeTurn;
      expect(activeTurn?.turnId).toBe('__pending_turn__');
    });

    await adapter.cancel({ sessionId: session.sessionId });
    expect(codex.request).not.toHaveBeenCalledWith(
      'turn/interrupt',
      expect.objectContaining({
        threadId: 'thread_early_cancel',
      })
    );

    resolveTurnStart?.({ turn: { id: 'turn_early_cancel', status: 'inProgress' } });

    await vi.waitFor(() => {
      expect(codex.request).toHaveBeenCalledWith('turn/interrupt', {
        threadId: 'thread_early_cancel',
        turnId: 'turn_early_cancel',
      });
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('turn/completed', {
      threadId: 'thread_early_cancel',
      turn: { id: 'turn_early_cancel', status: 'interrupted', error: null, items: [] },
    });

    await expect(promptPromise).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('cancel interrupts active turn and resolves prompt with cancelled', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_cancel', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
    await vi.waitFor(() => {
      const activeTurn = (
        adapter as unknown as {
          sessions: Map<string, { activeTurn: { turnId: string } | null }>;
        }
      ).sessions.get(session.sessionId)?.activeTurn;
      expect(activeTurn?.turnId).toBe('turn_cancel');
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
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
    const sessionUpdateMock = connection.sessionUpdate as ReturnType<typeof vi.fn>;
    const pendingPermissionUpdateIndex = sessionUpdateMock.mock.calls.findIndex(
      (call) =>
        call[0].update?.sessionUpdate === 'tool_call_update' && call[0].update?.status === 'pending'
    );
    expect(pendingPermissionUpdateIndex).toBeGreaterThanOrEqual(0);
    const pendingPermissionInvocationOrder =
      sessionUpdateMock.mock.invocationCallOrder[pendingPermissionUpdateIndex];
    const requestPermissionInvocationOrder = (
      connection.requestPermission as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    expect(pendingPermissionInvocationOrder).toBeDefined();
    expect(requestPermissionInvocationOrder).toBeDefined();
    expect(
      (pendingPermissionInvocationOrder as number) < (requestPermissionInvocationOrder as number)
    ).toBe(true);
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

  it('scopes allow_always command approvals by command pattern and cwd', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_allow_always', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
      id: 91,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_allow_always',
        turnId: 'turn_allow_always',
        itemId: 'item_allow_always',
        command: 'cat README.md',
        cwd: '/tmp/workspace',
      },
    });

    expect(connection.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({
          title: 'Read README.md',
          kind: 'read',
        }),
        options: expect.arrayContaining([
          expect.objectContaining({ optionId: 'allow_always', kind: 'allow_always' }),
          expect.objectContaining({ optionId: 'allow_once', kind: 'allow_once' }),
          expect.objectContaining({ optionId: 'reject_once', kind: 'reject_once' }),
        ]),
      })
    );
    expect(codex.respondSuccess).toHaveBeenCalledWith(91, { decision: 'accept' });

    (connection.requestPermission as ReturnType<typeof vi.fn>).mockClear();
    codex.respondSuccess.mockClear();

    await (
      adapter as unknown as {
        handleCodexServerRequest: (request: unknown) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: 92,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_allow_always',
        turnId: 'turn_allow_always',
        itemId: 'item_allow_always_2',
        command: 'cat README.md',
        cwd: '/tmp/workspace',
      },
    });

    expect(connection.requestPermission).not.toHaveBeenCalled();
    expect(codex.respondSuccess).toHaveBeenCalledWith(92, { decision: 'accept' });

    codex.respondSuccess.mockClear();

    await (
      adapter as unknown as {
        handleCodexServerRequest: (request: unknown) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: 93,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_allow_always',
        turnId: 'turn_allow_always',
        itemId: 'item_allow_always_3',
        command: 'ls src',
        cwd: '/tmp/workspace',
      },
    });

    expect(connection.requestPermission).toHaveBeenCalledTimes(1);
    expect(codex.respondSuccess).toHaveBeenCalledWith(93, { decision: 'accept' });

    (connection.requestPermission as ReturnType<typeof vi.fn>).mockClear();
    codex.respondSuccess.mockClear();

    await (
      adapter as unknown as {
        handleCodexServerRequest: (request: unknown) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: 94,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_allow_always',
        turnId: 'turn_allow_always',
        itemId: 'item_allow_always_4',
        command: 'cat README.md',
        cwd: '/tmp/other-workspace',
      },
    });

    expect(connection.requestPermission).toHaveBeenCalledTimes(1);
    expect(codex.respondSuccess).toHaveBeenCalledWith(94, { decision: 'accept' });
  });

  it('does not reuse allow_always scope when a chained command changes cwd', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      outcome: { outcome: 'selected', optionId: 'allow_always' },
    } satisfies RequestPermissionResponse);

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_allow_always_cd_scope', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
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
      id: 101,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_allow_always_cd_scope',
        turnId: 'turn_allow_always_cd_scope',
        itemId: 'item_allow_always_cd_scope_1',
        command: 'cd nested && cat README.md',
        cwd: '/tmp/workspace',
      },
    });

    expect(connection.requestPermission).toHaveBeenCalledTimes(1);
    expect(codex.respondSuccess).toHaveBeenCalledWith(101, { decision: 'accept' });

    (connection.requestPermission as ReturnType<typeof vi.fn>).mockClear();
    codex.respondSuccess.mockClear();

    await (
      adapter as unknown as {
        handleCodexServerRequest: (request: unknown) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: 102,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_allow_always_cd_scope',
        turnId: 'turn_allow_always_cd_scope',
        itemId: 'item_allow_always_cd_scope_2',
        command: 'cat README.md',
        cwd: '/tmp/workspace',
      },
    });

    expect(connection.requestPermission).toHaveBeenCalledTimes(1);
    expect(codex.respondSuccess).toHaveBeenCalledWith(102, { decision: 'accept' });

    (connection.requestPermission as ReturnType<typeof vi.fn>).mockClear();
    codex.respondSuccess.mockClear();

    await (
      adapter as unknown as {
        handleCodexServerRequest: (request: unknown) => Promise<void>;
      }
    ).handleCodexServerRequest({
      id: 103,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread_allow_always_cd_scope',
        turnId: 'turn_allow_always_cd_scope',
        itemId: 'item_allow_always_cd_scope_3',
        command: 'cd nested && cat README.md',
        cwd: '/tmp/workspace',
      },
    });

    expect(connection.requestPermission).not.toHaveBeenCalled();
    expect(codex.respondSuccess).toHaveBeenCalledWith(103, { decision: 'accept' });
  });

  it('reconciles turn/completed notifications that arrive before prompt attaches active turn', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_race', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    codex.request.mockImplementationOnce(async (method: string) => {
      if (method !== 'turn/start') {
        return {};
      }
      await (
        adapter as unknown as {
          handleCodexNotification: (method: string, params: unknown) => Promise<void>;
        }
      ).handleCodexNotification('turn/completed', {
        threadId: 'thread_race',
        turn: { id: 'turn_race', status: 'completed', error: null, items: [] },
      });

      return {
        turn: { id: 'turn_race', status: 'inProgress' },
      };
    });

    await expect(
      adapter.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      })
    ).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('clears stale tool call state when a turn ends without item/completed events', async () => {
    const { connection } = createMockConnection();
    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_stale_tools', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    const session = await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    codex.request.mockResolvedValueOnce({
      turn: { id: 'turn_stale_tools', status: 'inProgress' },
    });

    const promptPromise = adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await vi.waitFor(() => {
      expect(codex.request).toHaveBeenCalledWith(
        'turn/start',
        expect.objectContaining({ threadId: 'thread_stale_tools' })
      );
    });

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('item/started', {
      threadId: 'thread_stale_tools',
      turnId: 'turn_stale_tools',
      item: {
        type: 'commandExecution',
        id: 'item_stale_tool',
        status: 'inProgress',
        command: 'echo hello',
      },
    });

    const adapterSession = (
      adapter as unknown as {
        sessions: Map<
          string,
          { toolCallsByItemId: Map<string, unknown>; activeTurn: { turnId: string } | null }
        >;
      }
    ).sessions.get(session.sessionId);
    expect(adapterSession?.toolCallsByItemId.size).toBe(1);

    await (
      adapter as unknown as {
        handleCodexNotification: (method: string, params: unknown) => Promise<void>;
      }
    ).handleCodexNotification('turn/completed', {
      threadId: 'thread_stale_tools',
      turn: { id: 'turn_stale_tools', status: 'completed', error: null, items: [] },
    });

    await expect(promptPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(adapterSession?.activeTurn).toBeNull();
    expect(adapterSession?.toolCallsByItemId.size).toBe(0);
  });

  it('responds with codex error payload when approval bridge throws', async () => {
    const { connection } = createMockConnection();
    (connection.requestPermission as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('permission bridge unavailable')
    );

    const { client: codexClient, mocks: codex } = createMockCodexClient();
    const adapter = new CodexAppServerAcpAdapter(connection as AgentSideConnection, codexClient);

    await initializeAdapterWithDefaultModel(adapter, codex);

    codex.request.mockResolvedValueOnce({
      thread: { id: 'thread_approval_error', cwd: '/tmp/workspace' },
      approvalPolicy: DEFAULT_APPROVAL_POLICY,
      reasoningEffort: 'medium',
    });
    await adapter.newSession({
      cwd: '/tmp/workspace',
      mcpServers: [],
    });

    await expect(
      (
        adapter as unknown as {
          handleCodexServerRequest: (request: unknown) => Promise<void>;
        }
      ).handleCodexServerRequest({
        id: 32,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread_approval_error',
          turnId: 'turn_approval_error',
          itemId: 'item_approval_error',
          command: 'echo test',
        },
      })
    ).resolves.toBeUndefined();

    expect(codex.respondError).toHaveBeenCalledWith(
      32,
      expect.objectContaining({
        code: -32_600,
        message: 'Failed to process codex approval request',
      })
    );
  });
});
