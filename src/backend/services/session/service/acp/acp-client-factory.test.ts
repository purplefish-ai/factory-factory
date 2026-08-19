import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClientFactory } from './acp-client-factory';
import type { AcpPermissionBridge } from './acp-permission-bridge';
import type { AcpStartupSignal } from './acp-runtime-contracts';
import type { AcpRuntimeEventHandlers } from './acp-runtime-events';
import type { AcpClientOptions, PermissionPreset } from './types';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  initialize: vi.fn(),
  loadSession: vi.fn(),
  newSession: vi.fn(),
  ndJsonStream: vi.fn(),
  connections: [] as Array<{
    toClient: (agent: unknown) => unknown;
    stream: unknown;
  }>,
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
}));

vi.mock('@agentclientprotocol/sdk', () => {
  class MockClientSideConnection {
    readonly toClient: (agent: unknown) => unknown;
    readonly stream: unknown;
    initialize = mocks.initialize;
    loadSession = mocks.loadSession;
    newSession = mocks.newSession;

    constructor(toClient: (agent: unknown) => unknown, stream: unknown) {
      this.toClient = toClient;
      this.stream = stream;
      mocks.connections.push(this);
    }
  }

  return {
    ClientSideConnection: MockClientSideConnection,
    ndJsonStream: (...args: unknown[]) => mocks.ndJsonStream(...args),
    PROTOCOL_VERSION: 1,
  };
});

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => mocks.logger,
  getCurrentProcessEnv: () => ({ FROM_DEFAULT_PROVIDER: 'yes' }),
}));

type MockChildProcess = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
};

type RejectableSignal = AcpStartupSignal & { reject(error: Error): void };

const CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    type: 'select' as const,
    category: 'model',
    currentValue: 'sonnet',
    options: [{ value: 'sonnet', name: 'Sonnet' }],
  },
  {
    id: 'mode',
    name: 'Mode',
    type: 'select' as const,
    category: 'mode',
    currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }],
  },
];

function createMockChildProcess(options?: { exitAfterSigterm?: boolean }): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.pid = 12_345;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killed = signal !== undefined;
    if (signal === 'SIGTERM' && options?.exitAfterSigterm) {
      queueMicrotask(() => {
        child.signalCode = 'SIGTERM';
        child.emit('close', null, 'SIGTERM');
      });
    }
    if (signal === 'SIGKILL') {
      child.signalCode = 'SIGKILL';
      child.emit('close', null, 'SIGKILL');
    }
    return true;
  });
  return child;
}

function createSignal(): RejectableSignal {
  let rejectSignal!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectSignal = reject;
  });
  return { promise, dispose: vi.fn(), reject: rejectSignal };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function defaultOptions(overrides?: Partial<AcpClientOptions>): AcpClientOptions {
  return {
    provider: 'CLAUDE',
    workingDir: '/tmp/workspace',
    sessionId: 'log-session-1',
    ...overrides,
  };
}

function defaultHandlers(): AcpRuntimeEventHandlers {
  return {
    onRuntimeError: vi.fn(),
    onAcpEvent: vi.fn(),
    onAcpLog: vi.fn(),
  };
}

function createParams(overrides?: {
  options?: AcpClientOptions;
  handlers?: AcpRuntimeEventHandlers;
  shutdownSignal?: AcpStartupSignal;
  stopSignal?: AcpStartupSignal;
  installed?: boolean;
}) {
  return {
    sessionId: 'session-1',
    options: overrides?.options ?? defaultOptions(),
    handlers: overrides?.handlers ?? defaultHandlers(),
    metadata: {
      incarnationId: 'incarnation-1',
      purpose: overrides?.options?.purpose ?? ('active' as const),
      installed: overrides?.installed ?? false,
    },
    shutdownSignal: overrides?.shutdownSignal ?? createSignal(),
    stopSignal: overrides?.stopSignal ?? createSignal(),
    shouldDispatchRuntimeError: vi.fn(() => true),
  };
}

function setupSuccessfulSpawn(
  child = createMockChildProcess(),
  agentCapabilities: Record<string, unknown> = {}
): MockChildProcess {
  mocks.spawn.mockReturnValue(child);
  mocks.initialize.mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities,
    agentInfo: { name: 'test-adapter' },
  });
  mocks.newSession.mockResolvedValue({
    sessionId: 'provider-session-new',
    configOptions: CONFIG_OPTIONS,
  });
  mocks.loadSession.mockResolvedValue({ configOptions: CONFIG_OPTIONS });
  return child;
}

function permissionRequest(): RequestPermissionRequest {
  return {
    sessionId: 'session-1',
    toolCall: { toolCallId: 'tool-1', title: 'Edit', status: 'pending' },
    options: [
      { optionId: 'allow-always', kind: 'allow_always', name: 'Allow always' },
      { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
    ],
  } as RequestPermissionRequest;
}

describe('AcpClientFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connections.length = 0;
    mocks.ndJsonStream.mockReturnValue({
      writable: {},
      readable: { pipeThrough: () => ({}) },
    });
  });

  it.each([
    '',
    '   ',
  ])('rejects unusable working directory %j before spawning', async (workingDir) => {
    const factory = new AcpClientFactory();

    await expect(
      factory.createClient(createParams({ options: defaultOptions({ workingDir }) }))
    ).rejects.toThrow('ACP working directory is required before spawning adapter process');

    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('spawns the Claude adapter command', async () => {
    setupSuccessfulSpawn();

    await new AcpClientFactory().createClient(createParams());

    const [command, args] = mocks.spawn.mock.calls[0] ?? [];
    expect(command).toEqual(expect.stringContaining('claude-agent-acp'));
    expect(args).toEqual([]);
  });

  it('spawns the internal Codex adapter command', async () => {
    setupSuccessfulSpawn();

    await new AcpClientFactory().createClient(
      createParams({ options: defaultOptions({ provider: 'CODEX' }) })
    );

    const [command, args] = mocks.spawn.mock.calls[0] as [string, string[]];
    expect(command.length).toBeGreaterThan(0);
    expect(args).toContain('internal');
    expect(args).toContain('codex-app-server-acp');
    expect(
      args.some((arg) => arg.endsWith('src/cli/index.ts') || arg.endsWith('dist/src/cli/index.js'))
    ).toBe(true);
  });

  it('uses an adapter override verbatim', async () => {
    setupSuccessfulSpawn();

    await new AcpClientFactory().createClient(
      createParams({ options: defaultOptions({ adapterBinaryPath: '/opt/custom-acp' }) })
    );

    expect(mocks.spawn).toHaveBeenCalledWith('/opt/custom-acp', [], expect.any(Object));
  });

  it('uses configured environment and orphan-safe stdio spawn options', async () => {
    setupSuccessfulSpawn();
    const factory = new AcpClientFactory();
    factory.configureEnvironment({
      preferSourceEntrypoint: false,
      childProcessEnvProvider: () => ({ CUSTOM_ENV: 'preserved' }),
    });

    await factory.createClient(createParams({ options: defaultOptions({ provider: 'CODEX' }) }));

    expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
      cwd: '/tmp/workspace',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { CUSTOM_ENV: 'preserved', BROWSER: 'none', DOTENV_CONFIG_QUIET: 'true' },
      detached: false,
    });
  });

  it('normalizes stdio, initializes the SDK, and returns an uninstalled handle', async () => {
    const child = setupSuccessfulSpawn(undefined, { promptCapabilities: { image: true } });
    const params = createParams();

    const handle = await new AcpClientFactory().createClient(params);

    expect(mocks.ndJsonStream).toHaveBeenCalledTimes(1);
    expect(mocks.initialize).toHaveBeenCalledWith({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'factory-factory', title: 'Factory Factory', version: '1.2.0' },
    });
    expect(handle.child).toBe(child as unknown as ChildProcess);
    expect(handle.providerSessionId).toBe('provider-session-new');
    expect(handle.agentCapabilities).toEqual({ promptCapabilities: { image: true } });
    expect(handle.configOptions).toEqual(CONFIG_OPTIONS);
    expect(params.metadata.installed).toBe(false);
  });

  it('creates a new session with converted MCP environment entries', async () => {
    setupSuccessfulSpawn();

    await new AcpClientFactory().createClient(
      createParams({
        options: defaultOptions({
          mcpServers: [
            {
              name: 'workspace-tools',
              command: 'node',
              args: ['server.js'],
              env: { TOKEN: 'value', MODE: 'test' },
            },
          ],
        }),
      })
    );

    expect(mocks.newSession).toHaveBeenCalledWith({
      cwd: '/tmp/workspace',
      mcpServers: [
        {
          name: 'workspace-tools',
          command: 'node',
          args: ['server.js'],
          env: [
            { name: 'TOKEN', value: 'value' },
            { name: 'MODE', value: 'test' },
          ],
        },
      ],
    });
  });

  it('loads a stored provider session when supported', async () => {
    setupSuccessfulSpawn(undefined, { loadSession: true });

    const handle = await new AcpClientFactory().createClient(
      createParams({ options: defaultOptions({ resumeProviderSessionId: 'stored-provider-1' }) })
    );

    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: 'stored-provider-1',
      cwd: '/tmp/workspace',
      mcpServers: [],
    });
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(handle.providerSessionId).toBe('stored-provider-1');
  });

  it('logs an active load failure and falls back to a new session', async () => {
    setupSuccessfulSpawn(undefined, { loadSession: true });
    const loadError = Object.assign(new Error('provider forgot the session'), {
      code: -32_000,
      data: { retryable: false },
    });
    mocks.loadSession.mockRejectedValue(loadError);

    const handle = await new AcpClientFactory().createClient(
      createParams({ options: defaultOptions({ resumeProviderSessionId: 'stored-provider-1' }) })
    );

    expect(handle.providerSessionId).toBe('provider-session-new');
    expect(mocks.logger.warn).toHaveBeenCalledWith('loadSession failed', {
      sessionId: 'session-1',
      storedProviderSessionId: 'stored-provider-1',
      error: 'provider forgot the session',
      errorCode: -32_000,
      errorData: { retryable: false },
      fallback: 'newSession',
    });
  });

  it('classifies a browse load failure without creating a replacement session', async () => {
    setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }), {
      loadSession: true,
    });
    mocks.loadSession.mockRejectedValue(new Error('not found'));

    await expect(
      new AcpClientFactory().createClient(
        createParams({
          options: defaultOptions({
            purpose: 'browse',
            resumeProviderSessionId: 'stored-provider-1',
          }),
        })
      )
    ).rejects.toMatchObject({
      name: 'AcpBrowseSessionUnavailableError',
      message: 'Provider failed to restore this session for sub-agent browsing.',
    });
    expect(mocks.newSession).not.toHaveBeenCalled();
  });

  it('fails startup when session config options omit required categories', async () => {
    setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }));
    mocks.newSession.mockResolvedValue({
      sessionId: 'provider-session-new',
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Reasoning',
          type: 'select',
          category: 'thought_level',
          currentValue: 'medium',
          options: [{ value: 'medium', name: 'Medium' }],
        },
      ],
    });

    await expect(new AcpClientFactory().createClient(createParams())).rejects.toThrow(
      'missing required config option categories: model, mode'
    );
  });

  it('classifies spawn errors and dispatches the runtime error before cleanup', async () => {
    const child = createMockChildProcess({ exitAfterSigterm: true });
    mocks.spawn.mockReturnValue(child);
    mocks.initialize.mockReturnValue(new Promise(() => undefined));
    const handlers = defaultHandlers();
    const creation = new AcpClientFactory().createClient(createParams({ handlers }));
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));

    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    await expect(creation).rejects.toThrow(/Failed to spawn ACP adapter ".*": spawn ENOENT/);
    expect(handlers.onRuntimeError).toHaveBeenCalledWith({
      sessionId: 'session-1',
      error: expect.objectContaining({ message: 'spawn ENOENT' }),
      incarnationId: 'incarnation-1',
      purpose: 'active',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('times out startup and terminates the child', async () => {
    const child = setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }));
    mocks.initialize.mockReturnValue(new Promise(() => undefined));

    await expect(
      new AcpClientFactory({ acpStartupTimeoutMs: 10 }).createClient(createParams())
    ).rejects.toThrow('ACP initialize handshake timed out after 10ms');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('keeps the creation timeout snapshot when configuration changes during initialize', async () => {
    vi.useFakeTimers();
    try {
      setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }));
      const initialize = createDeferred<{
        protocolVersion: number;
        agentCapabilities: Record<string, unknown>;
      }>();
      const newSession = createDeferred<{
        sessionId: string;
        configOptions: typeof CONFIG_OPTIONS;
      }>();
      mocks.initialize.mockReturnValue(initialize.promise);
      mocks.newSession.mockReturnValue(newSession.promise);
      const factory = new AcpClientFactory({ acpStartupTimeoutMs: 100 });
      const creation = factory.createClient(createParams());
      const result = creation.then(
        (handle) => ({ handle }),
        (error: unknown) => ({ error })
      );
      await vi.advanceTimersByTimeAsync(0);

      factory.setAcpStartupTimeoutMs(10);
      initialize.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.newSession).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      newSession.resolve({
        sessionId: 'provider-session-after-config-change',
        configOptions: CONFIG_OPTIONS,
      });
      await vi.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toMatchObject({
        handle: { providerSessionId: 'provider-session-after-config-change' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'shutdown',
    'stop',
  ] as const)('preserves %s cancellation classification and leaves signal disposal to the manager', async (kind) => {
    const child = setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }));
    mocks.initialize.mockReturnValue(new Promise(() => undefined));
    const shutdownSignal = createSignal();
    const stopSignal = createSignal();
    const selectedSignal = kind === 'shutdown' ? shutdownSignal : stopSignal;
    const expected = new Error(`${kind} cancellation`);
    const creation = new AcpClientFactory().createClient(
      createParams({ shutdownSignal, stopSignal })
    );
    await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));

    selectedSignal.reject(expected);

    await expect(creation).rejects.toBe(expected);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(shutdownSignal.dispose).not.toHaveBeenCalled();
    expect(stopSignal.dispose).not.toHaveBeenCalled();
  });

  it('forwards adapter stderr to the ACP log handler', async () => {
    const child = setupSuccessfulSpawn();
    const handlers = defaultHandlers();
    await new AcpClientFactory().createClient(createParams({ handlers }));

    child.stderr.write('adapter warning\n');

    expect(handlers.onAcpLog).toHaveBeenCalledWith('log-session-1', {
      eventType: 'acp_stderr',
      data: 'adapter warning\n',
    });
  });

  it.each([
    ['RELAXED', 'allow-always'],
    ['YOLO', 'allow-always'],
    ['STRICT', 'bridge-choice'],
    [undefined, 'bridge-choice'],
  ] as [
    PermissionPreset | undefined,
    string,
  ][])('maps permission preset %s to the client policy', async (permissionPreset, expectedOptionId) => {
    setupSuccessfulSpawn();
    const permissionBridge = {
      waitForUserResponse: vi.fn().mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'bridge-choice' },
      }),
    } as unknown as AcpPermissionBridge;
    await new AcpClientFactory().createClient(
      createParams({
        options: defaultOptions({ permissionPreset }),
        handlers: { permissionBridge },
      })
    );
    const handler = mocks.connections[0]?.toClient({}) as {
      requestPermission(request: RequestPermissionRequest): Promise<{
        outcome: { optionId?: string };
      }>;
    };

    const response = await handler.requestPermission(permissionRequest());

    expect(response.outcome.optionId).toBe(expectedOptionId);
  });

  it('does not retain or deduplicate handles between creations', async () => {
    const firstChild = createMockChildProcess();
    const secondChild = createMockChildProcess();
    mocks.spawn.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    mocks.initialize.mockResolvedValue({ protocolVersion: 1, agentCapabilities: {} });
    mocks.newSession.mockResolvedValue({
      sessionId: 'provider-session-new',
      configOptions: CONFIG_OPTIONS,
    });
    const factory = new AcpClientFactory();

    const first = await factory.createClient(createParams());
    const second = await factory.createClient(createParams());

    expect(first.child).toBe(firstChild as unknown as ChildProcess);
    expect(second.child).toBe(secondChild as unknown as ChildProcess);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('waits for SIGTERM grace and escalates failed startup cleanup to SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const child = setupSuccessfulSpawn();
      mocks.initialize.mockRejectedValue(new Error('handshake failed'));
      const creation = new AcpClientFactory().createClient(createParams());
      const rejection = creation.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(0);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(4999);
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(1);
      await expect(rejection).resolves.toMatchObject({ message: 'handshake failed' });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});
