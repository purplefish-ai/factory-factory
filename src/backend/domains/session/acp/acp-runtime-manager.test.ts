import { EventEmitter } from 'node:events';
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
}));

// ---- Imports (after mocks) ----

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
    if (signal === 'SIGKILL') {
      child.killed = true;
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

function setupSuccessfulSpawn() {
  const child = createMockChildProcess();
  mockSpawn.mockReturnValue(child);
  mockInitialize.mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities: { loadSession: {} },
    agentInfo: { name: 'claude-code-acp' },
  });
  mockNewSession.mockResolvedValue({
    sessionId: 'provider-session-123',
    configOptions: [],
    modes: [],
  });
  mockSetSessionConfigOption.mockResolvedValue({
    configOptions: [],
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

      const spawnError = Object.assign(new Error('spawn claude-code-acp ENOENT'), {
        code: 'ENOENT',
      });
      child.emit('error', spawnError);

      await expect(createPromise).rejects.toThrow(
        /Failed to spawn ACP adapter ".*": spawn claude-code-acp ENOENT/
      );
      expect(handlers.onError).toHaveBeenCalledWith('session-1', expect.any(Error));
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
        configOptions: [],
        modes: [],
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
          type: 'string',
          category: 'model',
          currentValue: 'sonnet',
          options: [
            { value: 'sonnet', name: 'Sonnet' },
            { value: 'opus', name: 'Opus' },
          ],
        },
      ];
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
        configOptions: expectedConfigOptions,
        modes: [],
      });

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      expect(handle.configOptions).toEqual(expectedConfigOptions);
    });

    it('synthesizes config options from legacy Claude models/modes response', async () => {
      setupSuccessfulSpawn();
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
        models: {
          currentModelId: 'sonnet',
          availableModels: [
            { modelId: 'sonnet', name: 'Sonnet' },
            { modelId: 'opus', name: 'Opus' },
          ],
        },
        modes: {
          currentModeId: 'plan',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      });

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      const modelOption = handle.configOptions.find((option) => option.id === 'model');
      const modeOption = handle.configOptions.find((option) => option.id === 'mode');

      expect(modelOption).toMatchObject({
        id: 'model',
        category: 'model',
        currentValue: 'sonnet',
      });
      expect(modeOption).toMatchObject({
        id: 'mode',
        category: 'mode',
        currentValue: 'plan',
      });
      expect(
        modelOption?.options.map((option) => ('value' in option ? option.value : undefined))
      ).toEqual(expect.arrayContaining(['sonnet', 'opus']));
      expect(
        modeOption?.options.map((option) => ('value' in option ? option.value : undefined))
      ).toEqual(expect.arrayContaining(['default', 'plan']));
    });

    it('uses model family name for legacy Claude default model labels', async () => {
      setupSuccessfulSpawn();
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
        models: {
          currentModelId: 'default',
          availableModels: [
            {
              modelId: 'default',
              name: 'Default (recommended)',
              description: 'Opus 4.6 · best for complex tasks',
            },
            { modelId: 'sonnet', name: 'Sonnet 4.5' },
          ],
        },
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

      expect(defaultEntry).toMatchObject({
        value: 'default',
        name: 'Opus 4.6',
      });
    });
  });

  describe('stopClient', () => {
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
    it('falls back to legacy Claude mode setter when setSessionConfigOption fails', async () => {
      setupSuccessfulSpawn();
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
        models: {
          currentModelId: 'sonnet',
          availableModels: [{ modelId: 'sonnet', name: 'Sonnet' }],
        },
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      });
      mockSetSessionConfigOption.mockRejectedValueOnce(new Error('Method not found'));

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setConfigOption('session-1', 'mode', 'plan');

      expect(mockSetSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        configId: 'mode',
        value: 'plan',
      });
      expect(mockSetSessionMode).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        modeId: 'plan',
      });
      expect(handle.configOptions.find((option) => option.id === 'mode')?.currentValue).toBe(
        'plan'
      );
    });

    it('falls back to legacy Claude model setter when setSessionConfigOption fails', async () => {
      setupSuccessfulSpawn();
      mockNewSession.mockResolvedValueOnce({
        sessionId: 'provider-session-123',
        models: {
          currentModelId: 'sonnet',
          availableModels: [
            { modelId: 'sonnet', name: 'Sonnet' },
            { modelId: 'opus', name: 'Opus' },
          ],
        },
      });
      mockSetSessionConfigOption.mockRejectedValueOnce(new Error('Method not found'));

      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );

      await manager.setConfigOption('session-1', 'model', 'opus');

      expect(mockSetSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        configId: 'model',
        value: 'opus',
      });
      expect(mockSetSessionModel).toHaveBeenCalledWith({
        sessionId: 'provider-session-123',
        modelId: 'opus',
      });
      expect(handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
        'opus'
      );
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
