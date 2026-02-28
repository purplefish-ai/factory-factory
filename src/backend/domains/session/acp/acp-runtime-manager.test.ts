import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Hoisted mock state (shared between factory and tests) ----

const {
  mockSpawn,
  mockInitialize,
  mockNewSession,
  mockPrompt,
  mockCancel,
  mockSetSessionConfigOption,
  mockSetSessionMode,
  mockSetSessionModel,
  mockNdJsonStream,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockInitialize: vi.fn(),
  mockNewSession: vi.fn(),
  mockPrompt: vi.fn(),
  mockCancel: vi.fn(),
  mockSetSessionConfigOption: vi.fn(),
  mockSetSessionMode: vi.fn(),
  mockSetSessionModel: vi.fn(),
  mockNdJsonStream: vi.fn().mockReturnValue({ writable: {}, readable: {} }),
}));

// ---- Mocks ----

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('@agentclientprotocol/sdk', () => {
  class MockCSC {
    toClient: (agent: unknown) => unknown;
    initialize = mockInitialize;
    newSession = mockNewSession;
    prompt = mockPrompt;
    cancel = mockCancel;
    setSessionConfigOption = mockSetSessionConfigOption;
    setSessionMode = mockSetSessionMode;
    unstable_setSessionModel = mockSetSessionModel;

    constructor(toClient: (agent: unknown) => unknown, _stream: unknown) {
      this.toClient = toClient;
    }
  }

  return {
    ClientSideConnection: MockCSC,
    ndJsonStream: (...args: unknown[]) => mockNdJsonStream(...args),
    PROTOCOL_VERSION: 1,
  };
});

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
}));

// ---- Imports (after mocks) ----

import type { AcpEventCallback } from './acp-client-handler';
import { AcpClientHandler } from './acp-client-handler';
import type { AcpRuntimeEventHandlers } from './acp-runtime-manager';
import { AcpRuntimeManager } from './acp-runtime-manager';
import type { AcpClientOptions } from './types';

// ---- Helpers ----

function createMockChildProcess(): EventEmitter & {
  pid: number;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
  };
  child.pid = 12_345;
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn((signal?: string) => {
    if (signal) {
      // Match Node ChildProcess semantics: successful signal dispatch flips .killed
      child.killed = true;
    }
    if (signal === 'SIGKILL') {
      child.exitCode = 137;
      child.emit('exit', 137, 'SIGKILL');
    }
    return true;
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

function defaultOptions(): AcpClientOptions {
  return {
    provider: 'CLAUDE',
    workingDir: '/tmp/workspace',
    sessionId: 'test-session-1',
  };
}

function codexOptions(): AcpClientOptions {
  return {
    provider: 'CODEX',
    workingDir: '/tmp/workspace',
    sessionId: 'test-session-1',
  };
}

function opencodeOptions(): AcpClientOptions {
  return {
    provider: 'OPENCODE',
    workingDir: '/tmp/workspace',
    sessionId: 'test-session-1',
  };
}

function defaultHandlers(): AcpRuntimeEventHandlers {
  return {
    onSessionId: vi.fn().mockResolvedValue(undefined),
    onExit: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    onAcpEvent: vi.fn(),
  };
}

function defaultContext() {
  return { workspaceId: 'w1', workingDir: '/tmp/workspace' };
}

function defaultConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      type: 'select' as const,
      category: 'model',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      type: 'select' as const,
      category: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
}

function setupSuccessfulSpawn() {
  const child = createMockChildProcess();
  mockSpawn.mockReturnValue(child);
  mockInitialize.mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities: { loadSession: {} },
    agentInfo: { name: 'claude-agent-acp' },
  });
  mockNewSession.mockResolvedValue({
    sessionId: 'provider-session-123',
    configOptions: defaultConfigOptions(),
  });
  mockSetSessionConfigOption.mockResolvedValue({
    configOptions: defaultConfigOptions(),
  });
  mockSetSessionMode.mockResolvedValue({});
  mockSetSessionModel.mockResolvedValue({});
  return child;
}

// ---- Tests ----

describe('AcpRuntimeManager', () => {
  let manager: AcpRuntimeManager;

  beforeEach(() => {
    manager = new AcpRuntimeManager();
  });

  describe('getOrCreateClient', () => {
    it('spawns subprocess with detached:false, wires streams, initializes, creates session, returns handle', async () => {
      setupSuccessfulSpawn();

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      // Verify spawn was called with correct args
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnArgs = mockSpawn.mock.calls[0]!;
      expect(spawnArgs[1]).toEqual([]);
      expect(spawnArgs[2]).toMatchObject({
        cwd: '/tmp/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });

      // Verify initialize was called
      expect(mockInitialize).toHaveBeenCalledTimes(1);
      expect(mockInitialize).toHaveBeenCalledWith(
        expect.objectContaining({
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: expect.objectContaining({
            name: 'factory-factory',
          }),
        })
      );

      // Verify newSession was called
      expect(mockNewSession).toHaveBeenCalledTimes(1);
      expect(mockNewSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/tmp/workspace',
          mcpServers: [],
        })
      );

      // Verify handle state
      expect(handle.providerSessionId).toBe('provider-session-123');
      expect(handle.agentCapabilities).toEqual({ loadSession: {} });
      expect(handle.isPromptInFlight).toBe(false);
      expect(handle.isRunning()).toBe(true);
      expect(handle.getPid()).toBe(12_345);
    });

    it('spawns CODEX provider using internal CLI adapter command', async () => {
      setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        codexOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnArgs = mockSpawn.mock.calls[0]!;
      expect(spawnArgs[1]).toContain('internal');
      expect(spawnArgs[1]).toContain('codex-app-server-acp');
      expect(
        (spawnArgs[1] as string[]).some(
          (arg) => arg.endsWith('src/cli/index.ts') || arg.endsWith('dist/src/cli/index.js')
        )
      ).toBe(true);
      expect(typeof spawnArgs[0]).toBe('string');
      expect((spawnArgs[0] as string).length).toBeGreaterThan(0);
      expect((spawnArgs[2] as { env?: Record<string, string> }).env?.DOTENV_CONFIG_QUIET).toBe(
        'true'
      );
      if (
        (spawnArgs[0] as string).endsWith('tsx') ||
        (spawnArgs[0] as string).endsWith('tsx.cmd')
      ) {
        expect(spawnArgs[1]).toContain('--tsconfig');
        expect((spawnArgs[1] as string[]).some((arg) => arg.endsWith('tsconfig.json'))).toBe(true);
      }
      expect(spawnArgs[2]).toMatchObject({
        cwd: '/tmp/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    });

    it('spawns OPENCODE provider using `opencode acp` command', async () => {
      setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        opencodeOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnArgs = mockSpawn.mock.calls[0]!;
      expect(spawnArgs[1]).toEqual(['acp']);
      expect(typeof spawnArgs[0]).toBe('string');
      expect(spawnArgs[0] as string).toContain('opencode');
      expect((spawnArgs[2] as { env?: Record<string, string> }).env?.DOTENV_CONFIG_QUIET).toBe(
        undefined
      );
      expect(spawnArgs[2]).toMatchObject({
        cwd: '/tmp/workspace',
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    });

    it('resolves CODEX internal adapter from module location when cwd is outside repo', async () => {
      setupSuccessfulSpawn();
      const originalCwd = process.cwd();
      process.chdir(tmpdir());

      try {
        await manager.getOrCreateClient(
          'session-1',
          codexOptions(),
          defaultHandlers(),
          defaultContext()
        );
      } finally {
        process.chdir(originalCwd);
      }

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnArgs = mockSpawn.mock.calls[0]!;
      const command = spawnArgs[0] as string;
      const args = spawnArgs[1] as string[];
      expect(command.length).toBeGreaterThan(0);
      expect(args).toContain('internal');
      expect(args).toContain('codex-app-server-acp');
      if (command.endsWith('tsx') || command.endsWith('tsx.cmd')) {
        expect(args).toContain('--tsconfig');
        expect(args.some((arg) => arg.endsWith('tsconfig.json'))).toBe(true);
      }
      expect(
        args.some(
          (arg) => arg.endsWith('src/cli/index.ts') || arg.endsWith('dist/src/cli/index.js')
        )
      ).toBe(true);
    });

    it('rejects cleanly when ACP binary spawn fails (ENOENT)', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child);
      mockInitialize.mockImplementation(
        () =>
          new Promise(() => {
            // Intentionally unresolved so startup failure wins Promise.race.
          })
      );

      const handlers = defaultHandlers();
      const createPromise = manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        handlers,
        defaultContext()
      );
      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalledTimes(1);
      });

      const spawnError = Object.assign(new Error('spawn claude-agent-acp ENOENT'), {
        code: 'ENOENT',
      });
      child.emit('error', spawnError);

      await expect(createPromise).rejects.toThrow(
        /Failed to spawn ACP adapter ".*": spawn claude-agent-acp ENOENT/
      );
      expect(handlers.onError).toHaveBeenCalledWith('session-1', expect.any(Error));
    });

    it('kills subprocess when initialization fails after spawn', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child);
      mockInitialize.mockRejectedValue(new Error('handshake failed'));

      await expect(
        manager.getOrCreateClient(
          'session-1',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        )
      ).rejects.toThrow('handshake failed');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(mockNewSession).not.toHaveBeenCalled();
    });

    it('times out when ACP initialize handshake never resolves', async () => {
      manager.setAcpStartupTimeoutMs(20);

      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child);
      mockInitialize.mockImplementation(
        () =>
          new Promise(() => {
            // Keep unresolved to trigger startup timeout.
          })
      );

      await expect(
        manager.getOrCreateClient(
          'session-timeout-init',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        )
      ).rejects.toThrow('ACP initialize handshake timed out');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('times out when ACP session creation never resolves', async () => {
      manager.setAcpStartupTimeoutMs(20);

      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child);
      mockInitialize.mockResolvedValue({
        protocolVersion: 1,
        agentCapabilities: { loadSession: {} },
        agentInfo: { name: 'claude-agent-acp' },
      });
      mockNewSession.mockImplementation(
        () =>
          new Promise(() => {
            // Keep unresolved to trigger startup timeout.
          })
      );

      await expect(
        manager.getOrCreateClient(
          'session-timeout-new-session',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        )
      ).rejects.toThrow('ACP session creation timed out');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('returns existing handle if session already exists and is running', async () => {
      setupSuccessfulSpawn();

      const handle1 = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      const handle2 = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(handle1).toBe(handle2);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent creation for same sessionId', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child);

      let resolveInit!: (value: unknown) => void;
      mockInitialize.mockReturnValue(
        new Promise((resolve) => {
          resolveInit = resolve;
        })
      );
      mockNewSession.mockResolvedValue({
        sessionId: 'provider-session-123',
        configOptions: defaultConfigOptions(),
      });

      const first = manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      const second = manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      // Let microtasks process
      await new Promise((r) => setTimeout(r, 10));

      resolveInit({
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'test' },
      });

      const [h1, h2] = await Promise.all([first, second]);

      expect(h1).toBe(h2);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('calls onSessionId handler with provider session ID', async () => {
      setupSuccessfulSpawn();
      const handlers = defaultHandlers();

      await manager.getOrCreateClient('session-1', defaultOptions(), handlers, defaultContext());

      expect(handlers.onSessionId).toHaveBeenCalledWith('session-1', 'provider-session-123');
    });

    it('calls onClientCreated callback when set', async () => {
      setupSuccessfulSpawn();
      const callback = vi.fn();
      manager.setOnClientCreated(callback);

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(callback).toHaveBeenCalledWith('session-1', handle, defaultContext());
    });

    it('stores config options returned by ACP newSession', async () => {
      setupSuccessfulSpawn();
      const expectedConfigOptions = [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'sonnet',
          options: [
            { value: 'sonnet', name: 'Sonnet' },
            { value: 'opus', name: 'Opus' },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          category: 'mode',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'plan', name: 'Plan' },
          ],
        },
      ];
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
        configOptions: expectedConfigOptions,
      });

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(handle.configOptions).toEqual(expectedConfigOptions);
    });

    it('fails fast when ACP newSession omits configOptions', async () => {
      setupSuccessfulSpawn();
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
      });

      await expect(
        manager.getOrCreateClient(
          'session-1',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        )
      ).rejects.toThrow('did not include required configOptions');
    });

    it('derives required config options from models/modes when newSession omits configOptions', async () => {
      setupSuccessfulSpawn();
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
        models: {
          availableModels: [
            { modelId: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
          ],
          currentModelId: 'claude-opus-4-6',
        },
        modes: {
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
          currentModeId: 'default',
        },
      });

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      const modelOption = handle.configOptions.find((option) => option.category === 'model');
      const modeOption = handle.configOptions.find((option) => option.category === 'mode');

      expect(modelOption).toMatchObject({
        id: 'model',
        currentValue: 'claude-opus-4-6',
      });
      expect(modelOption?.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'claude-opus-4-6', name: 'Claude Opus 4.6' }),
          expect.objectContaining({ value: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }),
        ])
      );
      expect(modeOption).toMatchObject({
        id: 'mode',
        currentValue: 'default',
      });
      expect(modeOption?.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'default', name: 'Default' }),
          expect.objectContaining({ value: 'plan', name: 'Plan' }),
        ])
      );
    });

    it('fails fast when ACP newSession omits required model/mode categories', async () => {
      setupSuccessfulSpawn();
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
        configOptions: [
          {
            id: 'reasoning_effort',
            name: 'Reasoning Effort',
            type: 'select',
            category: 'thought_level',
            currentValue: 'medium',
            options: [{ value: 'medium', name: 'Medium' }],
          },
        ],
      });

      await expect(
        manager.getOrCreateClient(
          'session-1',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        )
      ).rejects.toThrow('missing required config option categories: model, mode');
    });

    it('uses model family name for Claude default model labels in configOptions', async () => {
      setupSuccessfulSpawn();
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'default',
            options: [
              {
                value: 'default',
                name: 'Default (recommended)',
                description: 'Opus 4.6 · best for complex tasks',
              },
              { value: 'sonnet', name: 'Sonnet 4.5' },
            ],
          },
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            category: 'mode',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'plan', name: 'Plan' },
            ],
          },
        ],
      });

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      const modelOption = handle.configOptions.find((option) => option.id === 'model');
      const defaultEntry = modelOption?.options.find(
        (option) => 'value' in option && option.value === 'default'
      );

      expect(defaultEntry).toMatchObject({ value: 'default', name: 'Opus 4.6' });
    });
  });

  describe('stopClient', () => {
    it('keeps creation lock bookkeeping when stop is already in progress', async () => {
      const child = setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      const internalManager = manager as unknown as {
        creationLocks: Map<string, unknown>;
        lockRefCounts: Map<string, number>;
      };
      internalManager.creationLocks.set('session-1', vi.fn());
      internalManager.lockRefCounts.set('session-1', 3);

      child.kill = vi.fn(() => {
        setTimeout(() => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }, 10);
        return true;
      });

      const stopPromise = manager.stopClient('session-1');
      await vi.waitFor(() => {
        expect(manager.isStopInProgress('session-1')).toBe(true);
      });

      await manager.stopClient('session-1');

      expect(internalManager.creationLocks.has('session-1')).toBe(true);
      expect(internalManager.lockRefCounts.has('session-1')).toBe(true);

      await stopPromise;
    });

    it('sends SIGTERM, waits grace period, cleans up references', async () => {
      const child = setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      // Make SIGTERM trigger exit
      child.kill = vi.fn(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        return true;
      });

      await manager.stopClient('session-1');

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(manager.getClient('session-1')).toBeUndefined();
    });

    it('escalates to SIGKILL after timeout', async () => {
      const child = setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      // SIGTERM does NOT cause exit - process stays alive
      const killCalls: string[] = [];
      child.kill = vi.fn((signal?: string) => {
        killCalls.push(signal ?? 'default');
        if (signal === 'SIGKILL') {
          child.killed = true;
          child.exitCode = 137;
          child.emit('exit', 137, 'SIGKILL');
        }
        return true;
      });

      vi.useFakeTimers();

      const stopPromise = manager.stopClient('session-1');

      // Advance past the 5s timeout
      await vi.advanceTimersByTimeAsync(5100);

      await stopPromise;

      expect(killCalls).toContain('SIGTERM');
      expect(killCalls).toContain('SIGKILL');
      expect(manager.getClient('session-1')).toBeUndefined();

      vi.useRealTimers();
    });

    it('cancels prompt if isPromptInFlight before SIGTERM', async () => {
      const child = setupSuccessfulSpawn();

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      handle.isPromptInFlight = true;

      mockCancel.mockResolvedValue(undefined);

      // Make SIGTERM trigger exit
      child.kill = vi.fn(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        return true;
      });

      await manager.stopClient('session-1');

      expect(mockCancel).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
      });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('is idempotent - double stop is no-op', async () => {
      const child = setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      // Make SIGTERM trigger exit with a delay to keep stop in progress
      child.kill = vi.fn(() => {
        setTimeout(() => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        }, 10);
        return true;
      });

      // Call stop twice concurrently
      const [, result2] = await Promise.all([
        manager.stopClient('session-1'),
        manager.stopClient('session-1'),
      ]);

      expect(result2).toBeUndefined();
    });

    it('skips exit handler when stop is in progress', async () => {
      const child = setupSuccessfulSpawn();
      const handlers = defaultHandlers();

      await manager.getOrCreateClient('session-1', defaultOptions(), handlers, defaultContext());

      // Clear the mock calls from initial creation
      (handlers.onExit as ReturnType<typeof vi.fn>).mockClear();

      // SIGTERM triggers exit event
      child.kill = vi.fn(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
        return true;
      });

      await manager.stopClient('session-1');

      // onExit should NOT be called during managed stop
      expect(handlers.onExit).not.toHaveBeenCalled();
    });

    it('keeps newer client tracked when old stop exits later', async () => {
      const firstChild = setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      // SIGTERM marks the old process as no longer running, but delay exit.
      firstChild.kill = vi.fn((signal?: string) => {
        if (signal) {
          firstChild.killed = true;
        }
        return true;
      });

      const stopPromise = manager.stopClient('session-1');
      await vi.waitFor(() => {
        expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
      });

      const secondChild = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(secondChild);

      const restartedHandle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      expect(restartedHandle.child).toBe(secondChild);

      firstChild.exitCode = 0;
      firstChild.emit('exit', 0, null);
      await stopPromise;

      expect(manager.getClient('session-1')).toBe(restartedHandle);
    });

    it('preserves in-flight pending creation when stale stop exit fires', async () => {
      const firstChild = setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      // SIGTERM marks process as no longer running but delays exit event.
      firstChild.kill = vi.fn((signal?: string) => {
        if (signal) {
          firstChild.killed = true;
        }
        return true;
      });

      const stopPromise = manager.stopClient('session-1');
      await vi.waitFor(() => {
        expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
      });

      const secondChild = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(secondChild);

      let resolveSecondInit!: (value: {
        protocolVersion: number;
        agentCapabilities: Record<string, unknown>;
        agentInfo: { name: string };
      }) => void;
      mockInitialize.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondInit = resolve;
          })
      );

      const pendingRestart = manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await vi.waitFor(() => {
        expect(mockSpawn).toHaveBeenCalledTimes(2);
      });

      const pendingBeforeStaleExit = manager.getPendingClient('session-1');
      expect(pendingBeforeStaleExit).toBeDefined();

      firstChild.exitCode = 0;
      firstChild.emit('exit', 0, null);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(manager.getPendingClient('session-1')).toBe(pendingBeforeStaleExit);
      const internalManager = manager as unknown as {
        creationLocks: Map<string, unknown>;
        lockRefCounts: Map<string, number>;
      };
      expect(internalManager.creationLocks.has('session-1')).toBe(true);
      expect(internalManager.lockRefCounts.get('session-1')).toBeGreaterThan(0);

      resolveSecondInit({
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'test' },
      });

      const restartedHandle = await pendingRestart;
      expect(restartedHandle.child).toBe(secondChild);

      await stopPromise;
    });
  });

  describe('sendPrompt', () => {
    it('sets isPromptInFlight, calls connection.prompt, clears flag on resolve', async () => {
      setupSuccessfulSpawn();
      mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(handle.isPromptInFlight).toBe(false);

      const result = await manager.sendPrompt('session-1', 'Hello world');

      expect(mockPrompt).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        prompt: [{ type: 'text', text: 'Hello world' }],
      });
      expect(result.stopReason).toBe('end_turn');
      expect(handle.isPromptInFlight).toBe(false);
    });

    it('clears isPromptInFlight on error', async () => {
      setupSuccessfulSpawn();
      mockPrompt.mockRejectedValue(new Error('prompt failed'));

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(manager.sendPrompt('session-1', 'Hello')).rejects.toThrow('prompt failed');
      expect(handle.isPromptInFlight).toBe(false);
    });

    it('throws if no session found', async () => {
      await expect(manager.sendPrompt('nonexistent', 'Hello')).rejects.toThrow(
        'No ACP session found'
      );
    });
  });

  describe('cancelPrompt', () => {
    it('calls connection.cancel when prompt is in flight', async () => {
      setupSuccessfulSpawn();
      mockCancel.mockResolvedValue(undefined);

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      handle.isPromptInFlight = true;

      await manager.cancelPrompt('session-1');

      expect(mockCancel).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
      });
    });

    it('does nothing when no prompt is in flight', async () => {
      setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.cancelPrompt('session-1');

      expect(mockCancel).not.toHaveBeenCalled();
    });

    it('does nothing for nonexistent session', async () => {
      await manager.cancelPrompt('nonexistent');
      expect(mockCancel).not.toHaveBeenCalled();
    });
  });

  describe('setConfigOption', () => {
    it('updates cached config options from setSessionConfigOption response', async () => {
      setupSuccessfulSpawn();
      mockSetSessionConfigOption.mockResolvedValueOnce({
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'opus',
            options: [
              { value: 'default', name: 'Default (recommended)', description: 'Opus 4.6 · best' },
              { value: 'opus', name: 'Opus' },
            ],
          },
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            category: 'mode',
            currentValue: 'plan',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'plan', name: 'Plan' },
            ],
          },
        ],
      });

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setConfigOption('session-1', 'mode', 'plan');

      const defaultModelOption = handle.configOptions
        .find((option) => option.id === 'model')
        ?.options.find((option) => 'value' in option && option.value === 'default');
      expect(defaultModelOption).toMatchObject({
        value: 'default',
        name: 'Opus 4.6',
      });
      expect(handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
        'plan'
      );
    });

    it('throws when setSessionConfigOption call fails', async () => {
      setupSuccessfulSpawn();
      mockSetSessionConfigOption.mockRejectedValueOnce(new Error('Method not found'));
      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(manager.setConfigOption('session-1', 'model', 'opus')).rejects.toThrow(
        'Method not found'
      );
    });

    it('fails fast when setSessionConfigOption response omits required categories', async () => {
      setupSuccessfulSpawn();
      mockSetSessionConfigOption.mockResolvedValueOnce({
        configOptions: [
          {
            id: 'reasoning_effort',
            name: 'Reasoning Effort',
            type: 'select',
            category: 'thought_level',
            currentValue: 'medium',
            options: [{ value: 'medium', name: 'Medium' }],
          },
        ],
      });
      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(manager.setConfigOption('session-1', 'mode', 'plan')).rejects.toThrow(
        'missing required config option categories: model, mode'
      );
    });
  });

  describe('setSessionMode', () => {
    it('calls ACP setSessionMode and updates cached mode currentValue', async () => {
      setupSuccessfulSpawn();
      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setSessionMode('session-1', 'plan');

      expect(mockSetSessionMode).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        modeId: 'plan',
      });
      expect(handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
        'plan'
      );
    });

    it('throws when setSessionMode call fails', async () => {
      setupSuccessfulSpawn();
      mockSetSessionMode.mockRejectedValueOnce(new Error('Invalid mode'));
      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await expect(manager.setSessionMode('session-1', 'acceptEdits')).rejects.toThrow(
        'Invalid mode'
      );
    });
  });

  describe('setSessionModel', () => {
    it('uses unstable_setSessionModel for CLAUDE and updates cached model currentValue', async () => {
      setupSuccessfulSpawn();
      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setSessionModel('session-1', 'opus');

      expect(mockSetSessionModel).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        modelId: 'opus',
      });
      expect(mockSetSessionConfigOption).not.toHaveBeenCalled();
      expect(handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
        'opus'
      );
    });

    it('falls back to setSessionConfigOption when unstable_setSessionModel is unavailable', async () => {
      setupSuccessfulSpawn();
      mockSetSessionModel.mockRejectedValueOnce({ code: -32_601, message: 'Method not found' });
      mockSetSessionConfigOption.mockResolvedValueOnce({
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'opus',
            options: [
              { value: 'sonnet', name: 'Sonnet' },
              { value: 'opus', name: 'Opus' },
            ],
          },
          {
            id: 'mode',
            name: 'Mode',
            type: 'select',
            category: 'mode',
            currentValue: 'default',
            options: [{ value: 'default', name: 'Default' }],
          },
        ],
      });
      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setSessionModel('session-1', 'opus');

      expect(mockSetSessionModel).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        modelId: 'opus',
      });
      expect(mockSetSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        configId: 'model',
        value: 'opus',
      });
      expect(handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
        'opus'
      );
    });

    it('uses setSessionConfigOption path for CODEX model updates', async () => {
      setupSuccessfulSpawn();
      await manager.getOrCreateClient(
        'session-1',
        { ...defaultOptions(), provider: 'CODEX' },
        defaultHandlers(),
        defaultContext()
      );

      await manager.setSessionModel('session-1', 'gpt-5.2-codex');

      expect(mockSetSessionModel).not.toHaveBeenCalled();
      expect(mockSetSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        configId: 'model',
        value: 'gpt-5.2-codex',
      });
    });
  });

  describe('session status methods', () => {
    it('isSessionRunning returns true for active session', async () => {
      setupSuccessfulSpawn();

      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(manager.isSessionRunning('session-1')).toBe(true);
      expect(manager.isSessionRunning('nonexistent')).toBe(false);
    });

    it('isSessionWorking returns true when prompt is in flight', async () => {
      setupSuccessfulSpawn();

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(manager.isSessionWorking('session-1')).toBe(false);
      handle.isPromptInFlight = true;
      expect(manager.isSessionWorking('session-1')).toBe(true);
    });

    it('isAnySessionWorking checks multiple sessions', async () => {
      setupSuccessfulSpawn();

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(manager.isAnySessionWorking(['session-1', 'session-2'])).toBe(false);
      handle.isPromptInFlight = true;
      expect(manager.isAnySessionWorking(['session-1', 'session-2'])).toBe(true);
    });
  });
});

describe('AcpClientHandler', () => {
  it('AcpEventCallback is a discriminated ACP runtime event union', () => {
    const onEvent: AcpEventCallback = (_sessionId, event) => {
      if (event.type === 'acp_session_update') {
        expect(event.update.sessionUpdate).toBe('agent_message_chunk');
        return;
      }

      expect(event.type).toBe('acp_permission_request');
      expect(event.params.toolCall.toolCallId).toBe('tc-1');
    };

    onEvent('test-session', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    });

    onEvent('test-session', {
      type: 'acp_permission_request',
      requestId: 'req-1',
      params: {
        sessionId: 'provider-session-1',
        toolCall: { toolCallId: 'tc-1', title: 'Write file' },
        options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow once' }],
      },
    });
  });

  it('sessionUpdate emits logs through onLog callback', async () => {
    const onEvent = vi.fn();
    const onLog = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent, undefined, onLog);

    await handler.sessionUpdate({
      sessionId: 'provider-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    });

    expect(onLog).toHaveBeenCalledWith('test-session', {
      eventType: 'acp_session_update',
      sessionUpdate: 'agent_message_chunk',
      data: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
    });
  });

  it('sessionUpdate forwards all events as acp_session_update wrapper', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    await handler.sessionUpdate({
      sessionId: 'provider-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    });

    expect(onEvent).toHaveBeenCalledWith('test-session', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    });
  });

  it('sessionUpdate forwards tool_call events as acp_session_update wrapper', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    await handler.sessionUpdate({
      sessionId: 'provider-session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read file',
        kind: 'read',
        status: 'in_progress',
      },
    });

    expect(onEvent).toHaveBeenCalledWith('test-session', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read file',
        kind: 'read',
        status: 'in_progress',
      },
    });
  });

  it('sessionUpdate forwards all event types including previously deferred ones', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    await handler.sessionUpdate({
      sessionId: 'provider-session-1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking...' },
      },
    });

    expect(onEvent).toHaveBeenCalledWith('test-session', {
      type: 'acp_session_update',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking...' },
      },
    });
  });

  it('requestPermission auto-approves with allow_always option', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    const result = await handler.requestPermission({
      sessionId: 'provider-session-1',
      toolCall: { toolCallId: 'tc-1', title: 'Write file' },
      options: [
        { optionId: 'reject-1', kind: 'reject_once', name: 'Deny' },
        { optionId: 'allow-1', kind: 'allow_always', name: 'Allow Always' },
        { optionId: 'allow-2', kind: 'allow_once', name: 'Allow Once' },
      ],
    });

    expect(result).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'allow-1',
      },
    });
  });

  it('requestPermission falls back to first option when no allow option exists', async () => {
    const onEvent = vi.fn();

    const handler = new AcpClientHandler('test-session', onEvent);

    const result = await handler.requestPermission({
      sessionId: 'provider-session-1',
      toolCall: { toolCallId: 'tc-1', title: 'Write file' },
      options: [
        { optionId: 'reject-1', kind: 'reject_once', name: 'Deny' },
        { optionId: 'reject-2', kind: 'reject_always', name: 'Deny Always' },
      ],
    });

    expect(result).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: 'reject-1',
      },
    });
  });
});
