import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk/unstable';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcpClientFactory,
  CONFIG_OPTIONS,
  createMockChildProcess,
  createParams,
  createSignal,
  defaultHandlers,
  defaultOptions,
  mocks,
  resetAcpClientFactoryMocks,
  setupSuccessfulSpawn,
} from '@/backend/services/session/service/acp/acp-client-factory.test-harness';
import { AcpEventProcessor } from '@/backend/services/session/service/events/acp-event-processor';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { AcpClientCallbacks } from './acp-connection';
import type { AcpPermissionBridge } from './acp-permission-bridge';
import { AcpRuntimeSupervisor } from './acp-runtime-supervisor';
import type { PermissionPreset } from './types';

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
  beforeEach(resetAcpClientFactoryMocks);

  it.each(['active', 'browse'] as const)(
    'resumes large hydrated history for %s without overflowing startup or duplicating messages',
    async (purpose) => {
      const child = createMockChildProcess({ exitAfterSigterm: true });
      setupSuccessfulSpawn(child, { loadSession: true });
      const supervisor = new AcpRuntimeSupervisor({
        clientFactory: new AcpClientFactory(),
        cancelPrompt: async () => false,
      });
      const domain = new SessionDomainService();
      domain.injectCommittedUserMessage('session-1', 'Saved history');
      let promptInFlight = false;
      const processor = new AcpEventProcessor({
        sessionDomainService: domain,
        runtimeManager: unsafeCoerce({
          getClient: () => supervisor.getClient('session-1'),
          isSessionPromptInFlight: () => promptInFlight,
        }),
        sessionPermissionService: unsafeCoerce({ createPermissionBridge: () => undefined }),
        sessionConfigService: unsafeCoerce({}),
        onToolCallTimeout: () => undefined,
      });
      processor.setReplaySuppression('session-1', true);
      const handlers = processor.createRuntimeEventHandler('session-1');
      const onAcpEvent = vi.fn(handlers.onAcpEvent);
      mocks.loadSession.mockImplementation(async () => {
        const client = unsafeCoerce<AcpClientCallbacks>(mocks.connections[0]?.toClient({}));
        for (let index = 0; index < 20_000; index++) {
          await client.sessionUpdate({
            sessionId: 'existing-thread',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Already loaded' },
            },
          });
        }
        await client.sessionUpdate({
          sessionId: 'existing-thread',
          update: { sessionUpdate: 'usage_update', used: 123, size: 1000 },
        });
        await client.sessionUpdate({
          sessionId: 'existing-thread',
          update: { sessionUpdate: 'plan', entries: [] },
        });
        return { configOptions: CONFIG_OPTIONS };
      });

      try {
        const handle = await supervisor.getOrCreateClient(
          'session-1',
          defaultOptions({
            provider: 'CODEX',
            resumeProviderSessionId: 'existing-thread',
            purpose,
          }),
          { ...handlers, onAcpEvent },
          { workspaceId: 'workspace-1', workingDir: tmpdir() }
        );
        expect(handle.providerSessionId).toBe('existing-thread');
        expect(handle.sessionCreationOutcome).toEqual({ kind: 'resumed' });
        expect(onAcpEvent.mock.calls.map(([, event]) => event)).toEqual([
          {
            type: 'acp_session_update',
            update: { sessionUpdate: 'usage_update', used: 123, size: 1000 },
          },
          { type: 'acp_session_update', update: { sessionUpdate: 'plan', entries: [] } },
        ]);
        expect(
          domain
            .getTranscriptSnapshot('session-1')
            .map((entry) => entry.text ?? entry.message?.type)
        ).toEqual(['Saved history', 'result']);
        promptInFlight = true;
        const client = unsafeCoerce<AcpClientCallbacks>(mocks.connections[0]?.toClient({}));
        await client.sessionUpdate({
          sessionId: 'existing-thread',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Live response' },
          },
        });
        processor.finishPromptTurn('session-1');
        expect(domain.getTranscriptSnapshot('session-1').at(-1)?.message?.message?.content).toEqual(
          [{ type: 'text', text: 'Live response' }]
        );
      } finally {
        await supervisor.stopAllClients();
        domain.clearAllSessions();
      }
    }
  );

  it.each([true, false])(
    'preserves new conversation output with a replay filter (fallback: %s)',
    async (fallback) => {
      setupSuccessfulSpawn(undefined, { loadSession: true });
      const handlers = { ...defaultHandlers(), consumeReplayEvent: () => true };
      const emitText = async (text: string) => {
        const client = unsafeCoerce<AcpClientCallbacks>(mocks.connections[0]?.toClient({}));
        await client.sessionUpdate({
          sessionId: 'provider-thread',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        });
      };
      mocks.loadSession.mockImplementation(async () => {
        await emitText('Failed history');
        throw new Error('Missing conversation');
      });
      mocks.newSession.mockImplementation(async () => {
        await emitText('New conversation');
        return { sessionId: 'new-thread', configOptions: CONFIG_OPTIONS };
      });
      await new AcpClientFactory().createClient(
        createParams({
          handlers,
          options: defaultOptions({ resumeProviderSessionId: fallback ? 'old-thread' : undefined }),
        })
      );
      expect(handlers.onAcpEvent).toHaveBeenCalledExactlyOnceWith('session-1', {
        type: 'acp_session_update',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'New conversation' },
        },
      });
    }
  );

  it.each(['', '   '])(
    'rejects unusable working directory %j before spawning',
    async (workingDir) => {
      const factory = new AcpClientFactory();

      await expect(
        factory.createClient(createParams({ options: defaultOptions({ workingDir }) }))
      ).rejects.toThrow('ACP working directory is required before spawning adapter process');

      expect(mocks.spawn).not.toHaveBeenCalled();
    }
  );

  it('spawns the Claude adapter command', async () => {
    setupSuccessfulSpawn();

    await new AcpClientFactory().createClient(createParams());

    const [command, args] = mocks.spawn.mock.calls[0] ?? [];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([expect.stringContaining('claude-agent-acp')]);
  });

  it('spawns the released Codex adapter with the host Node runtime', async () => {
    setupSuccessfulSpawn();
    await new AcpClientFactory().createClient(
      createParams({ options: defaultOptions({ provider: 'CODEX' }) })
    );
    const [command, args] = mocks.spawn.mock.calls[0] as [string, string[]];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([expect.stringContaining('@agentclientprotocol/codex-acp')]);
  });

  it('resumes a legacy Codex identity without changing durable identity', async () => {
    setupSuccessfulSpawn(undefined, { loadSession: true });
    mocks.loadSession.mockResolvedValue({ configOptions: CONFIG_OPTIONS });
    const handle = await new AcpClientFactory().createClient(
      createParams({
        options: defaultOptions({
          provider: 'CODEX',
          resumeProviderSessionId: 'sess_native-thread',
        }),
      })
    );
    expect(mocks.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'native-thread' })
    );
    expect(handle.providerSessionId).toBe('sess_native-thread');
    expect(mocks.newSession).not.toHaveBeenCalled();
  });

  it('never replaces a failed legacy Codex resume with a fresh conversation', async () => {
    setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }), { loadSession: true });
    const loadError = Object.assign(new Error('Internal error'), {
      code: -32_603,
      data: { details: 'no rollout found for thread id native-thread' },
    });
    mocks.loadSession.mockRejectedValue(loadError);
    await expect(
      new AcpClientFactory().createClient(
        createParams({
          options: defaultOptions({
            provider: 'CODEX',
            resumeProviderSessionId: 'sess_native-thread',
          }),
        })
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining('no rollout found for thread id native-thread'),
      cause: loadError,
    });
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'loadSession failed',
      expect.not.objectContaining({ fallback: 'newSession' })
    );
  });

  it('preserves a Codex conversation held by another client instead of replacing it', async () => {
    const child = setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }), {
      loadSession: true,
    });
    const loadError = Object.assign(new Error('This Codex session is in use by another client'), {
      code: -32_600,
      data: { reason: 'thread_active_writer', threadId: 'native-thread' },
    });
    mocks.loadSession.mockRejectedValue(loadError);
    const discardFailedResumeReplay = vi.fn();

    await expect(
      new AcpClientFactory().createClient({
        ...createParams({
          options: defaultOptions({ provider: 'CODEX', resumeProviderSessionId: 'native-thread' }),
        }),
        discardFailedResumeReplay,
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('Close the session in the other client'),
      cause: loadError,
    });
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(discardFailedResumeReplay).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'loadSession failed',
      expect.not.objectContaining({ fallback: 'newSession' })
    );
  });

  it('uses an adapter override verbatim', async () => {
    setupSuccessfulSpawn();

    await new AcpClientFactory().createClient(
      createParams({ options: defaultOptions({ adapterBinaryPath: '/opt/custom-acp' }) })
    );

    expect(mocks.spawn).toHaveBeenCalledWith('/opt/custom-acp', [], expect.any(Object));
  });

  it('spawns a saved Codex profile without inheriting default credentials', async () => {
    setupSuccessfulSpawn();
    const factory = new AcpClientFactory();
    factory.configureEnvironment({
      childProcessEnvProvider: () => ({ OPENAI_API_KEY: 'wrong', CODEX_HOME: '/default' }),
    });
    await factory.createClient(
      createParams({
        options: defaultOptions({
          provider: 'CODEX',
          codexAccountContext: {
            accountId: 'managed',
            homeDir: '/managed',
            sessionsDir: '/managed/sessions',
            env: { CODEX_HOME: '/managed' },
          },
        }),
      })
    );
    expect(mocks.spawn.mock.calls[0]?.[2].env).toMatchObject({ CODEX_HOME: '/managed' });
    expect(mocks.spawn.mock.calls[0]?.[2].env).not.toHaveProperty('OPENAI_API_KEY');
  });
  it('never replaces a failed modern Codex resume on its saved account', async () => {
    setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }), { loadSession: true });
    mocks.loadSession.mockRejectedValue(new Error('account does not own this rollout'));
    await expect(
      new AcpClientFactory().createClient(
        createParams({
          options: defaultOptions({
            provider: 'CODEX',
            resumeProviderSessionId: '01900000-1111-7777-8888-111111111111',
            codexAccountContext: {
              accountId: 'saved-resume',
              homeDir: '/saved-resume',
              sessionsDir: '/saved-resume/sessions',
              env: { CODEX_HOME: '/saved-resume' },
            },
          }),
        })
      )
    ).rejects.toThrow('account does not own this rollout');
    expect(mocks.spawn.mock.calls[0]?.[2].env).toMatchObject({ CODEX_HOME: '/saved-resume' });
    expect(mocks.newSession).not.toHaveBeenCalled();
  });
  it('uses configured environment and orphan-safe stdio spawn options', async () => {
    setupSuccessfulSpawn();
    const factory = new AcpClientFactory();
    factory.configureEnvironment({
      childProcessEnvProvider: () => ({ CUSTOM_ENV: 'preserved' }),
    });

    await factory.createClient(createParams({ options: defaultOptions({ provider: 'CODEX' }) }));

    expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), {
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        CUSTOM_ENV: 'preserved',
        BROWSER: 'none',
        ELECTRON_RUN_AS_NODE: '1',
        DOTENV_CONFIG_QUIET: 'true',
        DISABLE_MCP_CONFIG_FILTERING: 'true',
      },
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
      clientCapabilities: expect.objectContaining({
        session: { compaction: {} },
        elicitation: { form: {}, url: {} },
        subagents: {},
        _meta: {
          terminal_output_delta: true,
          jetbrains: {
            air: { version: 1, capabilities: ['asyncTasks', 'sessionFailure', 'loadReplayEnd'] },
          },
        },
      }),
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
      cwd: tmpdir(),
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

  it.each(['CLAUDE', 'CODEX'] as const)(
    'requires the existing %s conversation for background delivery',
    async (provider) => {
      for (const failure of ['missing', 'unsupported', 'failed']) {
        mocks.newSession.mockClear();
        setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }), {
          loadSession: failure !== 'unsupported',
        });
        if (failure === 'failed') {
          mocks.loadSession.mockRejectedValue(new Error('forgotten conversation'));
        }
        await expect(
          new AcpClientFactory().createClient(
            createParams({
              options: defaultOptions({
                provider,
                resumePolicy: 'require_existing',
                resumeProviderSessionId: failure === 'missing' ? undefined : 'stored-provider',
              }),
            })
          )
        ).rejects.toThrow('existing');
        expect(mocks.newSession).not.toHaveBeenCalled();
      }
    }
  );

  it('loads a stored provider session when supported', async () => {
    setupSuccessfulSpawn(undefined, { loadSession: true });

    const handle = await new AcpClientFactory().createClient(
      createParams({ options: defaultOptions({ resumeProviderSessionId: 'stored-provider-1' }) })
    );

    expect(mocks.loadSession).toHaveBeenCalledWith({
      sessionId: 'stored-provider-1',
      cwd: tmpdir(),
      mcpServers: [],
    });
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(handle.providerSessionId).toBe('stored-provider-1');
    expect(handle.sessionCreationOutcome).toEqual({ kind: 'resumed' });
  });

  it('logs an active load failure and falls back to a new session', async () => {
    setupSuccessfulSpawn(undefined, { loadSession: true });
    const loadError = Object.assign(new Error('provider forgot the session'), {
      code: -32_000,
      data: { retryable: false },
    });
    mocks.loadSession.mockRejectedValue(loadError);
    const discardFailedResumeReplay = vi.fn();

    const handle = await new AcpClientFactory().createClient({
      ...createParams({
        options: defaultOptions({ resumeProviderSessionId: 'stored-provider-1' }),
      }),
      discardFailedResumeReplay,
    });

    expect(discardFailedResumeReplay.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.newSession.mock.invocationCallOrder[0]!
    );
    expect(handle.providerSessionId).toBe('provider-session-new');
    expect(handle.sessionCreationOutcome).toEqual({
      kind: 'resume_fallback',
      previousProviderSessionId: 'stored-provider-1',
      reason: 'load_failed',
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith('loadSession failed', {
      sessionId: 'session-1',
      storedProviderSessionId: 'stored-provider-1',
      error: 'provider forgot the session',
      errorCode: -32_000,
      errorData: { retryable: false },
      fallback: 'newSession',
    });
  });

  it('reports unsupported loadSession as an explicit resume fallback', async () => {
    setupSuccessfulSpawn();
    const handle = await new AcpClientFactory().createClient(
      createParams({ options: defaultOptions({ resumeProviderSessionId: 'stored-provider-1' }) })
    );
    expect(handle.sessionCreationOutcome).toEqual({
      kind: 'resume_fallback',
      previousProviderSessionId: 'stored-provider-1',
      reason: 'load_unsupported',
    });
    expect(mocks.loadSession).not.toHaveBeenCalled();
  });

  it.each([
    ['CLAUDE', 'stored-provider-1'],
    ['CODEX', 'sess_native-thread'],
  ] as const)(
    'classifies a %s browse load failure without replacing its session',
    async (provider, resumeProviderSessionId) => {
      setupSuccessfulSpawn(createMockChildProcess({ exitAfterSigterm: true }), {
        loadSession: true,
      });
      mocks.loadSession.mockRejectedValue(new Error('not found'));

      await expect(
        new AcpClientFactory().createClient(
          createParams({
            options: defaultOptions({
              provider,
              purpose: 'browse',
              resumeProviderSessionId,
            }),
          })
        )
      ).rejects.toMatchObject({
        name: 'AcpBrowseSessionUnavailableError',
        message: 'Provider failed to restore this session for sub-agent browsing.',
      });
      expect(mocks.newSession).not.toHaveBeenCalled();
    }
  );

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
    ['RELAXED', 'reject-once'],
    ['YOLO', 'reject-once'],
    ['STRICT', 'reject-once'],
    [undefined, 'reject-once'],
  ] as [PermissionPreset | undefined, string][])(
    'lets the adapter own permissions for saved preset %s',
    async (permissionPreset, expectedOptionId) => {
      setupSuccessfulSpawn();
      const permissionBridge = {
        resolveAutomaticPermission: vi.fn(),
        waitForUserResponse: vi.fn().mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'reject-once' },
        }),
      } as unknown as AcpPermissionBridge;
      const handle = await new AcpClientFactory().createClient(
        createParams({
          options: defaultOptions({ permissionPreset }),
          handlers: { permissionBridge },
        })
      );
      expect(handle).toHaveProperty('permissionBridge', permissionBridge);
      const handler = mocks.connections[0]?.toClient({}) as {
        requestPermission(request: RequestPermissionRequest): Promise<{
          outcome: { optionId?: string };
        }>;
      };

      const response = await handler.requestPermission(permissionRequest());

      expect(response.outcome.optionId).toBe(expectedOptionId);
    }
  );

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
  it.each(['initialize', 'session', 'config', 'abort'] as const)(
    'retains strict cleanup uncertainty after event %s failure',
    async (phase) => {
      const child = setupSuccessfulSpawn();
      const stopSignal = createSignal();
      if (phase === 'initialize') {
        mocks.initialize.mockRejectedValueOnce(new Error('handshake failed'));
      }
      if (phase === 'session') {
        mocks.newSession.mockRejectedValueOnce(new Error('session failed'));
      }
      if (phase === 'config') {
        mocks.newSession.mockResolvedValueOnce({
          sessionId: 'native',
          configOptions: CONFIG_OPTIONS.map((option) =>
            option.id === 'model' ? { ...option, currentValue: 'other' } : option
          ),
        });
        mocks.setSessionConfigOption.mockRejectedValueOnce(new Error('model configuration failed'));
      }
      if (phase === 'abort') {
        mocks.initialize.mockReturnValueOnce(new Promise(() => undefined));
      }
      const cleanup = vi.fn().mockResolvedValue('UNKNOWN');
      const onOwnedProcessSpawned = vi.fn(() => {
        if (phase === 'abort') {
          queueMicrotask(() => stopSignal.reject(new Error('stop requested')));
        }
        return cleanup;
      });
      await expect(
        new AcpClientFactory().createClient({
          ...createParams({
            options: defaultOptions({
              ownedProcessGroup: true,
              ...(phase === 'config' ? { model: 'sonnet' } : {}),
            }),
            stopSignal,
          }),
          onOwnedProcessSpawned,
        })
      ).rejects.toThrow('Event runtime startup cleanup is unconfirmed');
      expect(onOwnedProcessSpawned).toHaveBeenCalledWith(
        child,
        process.platform === 'win32' ? undefined : child.pid,
        false
      );
      if (phase === 'config') {
        expect(mocks.setSessionConfigOption).toHaveBeenCalledWith({
          sessionId: 'native',
          configId: 'model',
          value: 'sonnet',
        });
      }
      expect(cleanup).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
    }
  );

  it('preserves definitive event spawn failure without claiming cleanup of an unknown process', async () => {
    const child = setupSuccessfulSpawn();
    Object.defineProperty(child, 'pid', { value: undefined });
    mocks.initialize.mockReturnValueOnce(new Promise(() => undefined));
    const cleanup = vi.fn(async () => 'UNKNOWN' as const);
    const pending = new AcpClientFactory().createClient({
      ...createParams({ options: defaultOptions({ ownedProcessGroup: true }) }),
      onOwnedProcessSpawned: () => cleanup,
    });
    const rejected = expect(pending).rejects.toThrow('ENOENT');
    child.emit('error', Object.assign(new Error('ENOENT executable missing'), { code: 'ENOENT' }));
    await rejected;
    expect(cleanup).not.toHaveBeenCalled();
  });
});
