import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AcpRuntimeManager,
  createManagerTestHarness,
  mockInitialize,
  mockNewSession,
  mockSpawn,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  codexOptions,
  createMockChildProcess,
  defaultConfigOptions,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  exitChildAfterSigterm,
} from './acp-runtime-manager.test-helpers';

describe('AcpRuntimeManager', () => {
  let manager: AcpRuntimeManager;

  beforeEach(() => {
    ({ manager } = createManagerTestHarness());
  });

  describe('getOrCreateClient', () => {
    it('rejects before spawn when workingDir is empty', async () => {
      await expect(
        manager.getOrCreateClient(
          'session-empty-cwd',
          { ...defaultOptions(), workingDir: '' },
          defaultHandlers(),
          defaultContext()
        )
      ).rejects.toThrow('ACP working directory is required before spawning adapter process');

      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('rejects before spawn when workingDir is whitespace only', async () => {
      await expect(
        manager.getOrCreateClient(
          'session-whitespace-cwd',
          { ...defaultOptions(), workingDir: '   ' },
          defaultHandlers(),
          defaultContext()
        )
      ).rejects.toThrow('ACP working directory is required before spawning adapter process');

      expect(mockSpawn).not.toHaveBeenCalled();
    });

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

      vi.useFakeTimers();

      try {
        const handlers = defaultHandlers();
        const createResult = manager
          .getOrCreateClient('session-1', defaultOptions(), handlers, defaultContext())
          .then(
            (handle) => ({ handle }),
            (error: unknown) => ({ error })
          );
        let creationSettled = false;
        void createResult.then(() => {
          creationSettled = true;
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(mockSpawn).toHaveBeenCalledTimes(1);

        const spawnError = Object.assign(new Error('spawn claude-agent-acp ENOENT'), {
          code: 'ENOENT',
        });
        child.emit('error', spawnError);
        await vi.advanceTimersByTimeAsync(0);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');

        child.emit('close', -2, null);
        await vi.advanceTimersByTimeAsync(0);

        expect(creationSettled).toBe(true);
        await expect(createResult).resolves.toMatchObject({
          error: {
            message: expect.stringMatching(
              /Failed to spawn ACP adapter ".*": spawn claude-agent-acp ENOENT/
            ),
          },
        });
        expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
        expect(handlers.onError).toHaveBeenCalledWith('session-1', expect.any(Error));
      } finally {
        await vi.advanceTimersByTimeAsync(5000);
        vi.useRealTimers();
      }
    });

    it('allows the subprocess to exit during the SIGTERM grace period after initialization fails', async () => {
      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
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

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
      expect(mockNewSession).not.toHaveBeenCalled();
    });

    it('does not signal a subprocess that already terminated from a signal', async () => {
      const child = createMockChildProcess();
      child.signalCode = 'SIGTERM';
      mockSpawn.mockReturnValue(child);
      mockInitialize.mockRejectedValue(new Error('handshake failed'));
      vi.useFakeTimers();

      try {
        const creationPromise = manager.getOrCreateClient(
          'session-1',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        );
        const creationRejection = creationPromise.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(5000);
        await expect(creationRejection).resolves.toMatchObject({ message: 'handshake failed' });
        expect(child.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('escalates failed initialization cleanup to SIGKILL after the grace period', async () => {
      const child = createMockChildProcess();
      mockSpawn.mockReturnValue(child);
      mockInitialize.mockRejectedValue(new Error('handshake failed'));
      vi.useFakeTimers();

      try {
        const creationPromise = manager.getOrCreateClient(
          'session-1',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        );
        const creationRejection = creationPromise.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(0);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

        await vi.advanceTimersByTimeAsync(4999);
        expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

        await vi.advanceTimersByTimeAsync(1);
        await expect(creationRejection).resolves.toMatchObject({ message: 'handshake failed' });
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      } finally {
        vi.useRealTimers();
      }
    });

    it('times out when ACP initialize handshake never resolves', async () => {
      manager.setAcpStartupTimeoutMs(20);

      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
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
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    });

    it('times out when ACP session creation never resolves', async () => {
      manager.setAcpStartupTimeoutMs(20);

      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
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
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
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
      const child = setupSuccessfulSpawn();
      exitChildAfterSigterm(child);
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
      const child = setupSuccessfulSpawn();
      exitChildAfterSigterm(child);
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
      expect(defaultEntry).toMatchObject({ value: 'default', name: 'Default — Opus 4.6' });
    });
  });
});
