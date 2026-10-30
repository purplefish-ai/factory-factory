import { beforeEach, describe, expect, it, vi } from 'vitest';
import { interceptorRegistry } from '@/backend/interceptors/registry';
import { SessionDomainService } from '@/backend/services/session';
import { PromptTimeoutError } from '@/backend/services/session/service/acp';
import { AcpNativeSessionTracker } from '@/backend/services/session/service/acp/acp-native-session-tracker';
import { AcpEventProcessor } from './acp-event-processor';
import { SessionLifecycleEventService } from './session-lifecycle-event.service';
import { SessionService } from './session.service';

function createPromptService() {
  const runtimeManager = {
    getClient: vi.fn().mockReturnValue({ supportsImages: () => true }),
    sendPrompt: vi.fn(),
    isSessionWorking: vi.fn().mockReturnValue(false),
  };
  const sessionDomainService = {
    setRuntimeSnapshot: vi.fn(),
  };
  const acpEventProcessor = {
    getWorkspaceId: vi.fn().mockReturnValue('workspace-1'),
    getProvider: vi.fn().mockReturnValue('CODEX'),
    beginPromptTurn: vi.fn().mockReturnValue('attempt-key'),
    abandonPromptTurn: vi.fn(),
    finishPromptTurn: vi.fn(),
    finalizeOrphanedToolCalls: vi.fn(),
  };
  const lifecycleEventService = {
    record: vi.fn().mockResolvedValue(undefined),
  };
  const promptTurnCompletionService = {
    schedule: vi.fn(),
  };
  const isSessionStopping = vi.fn().mockReturnValue(false);
  const isGenerationCurrent = vi.fn().mockReturnValue(true);
  const lifecycleGate = {
    getGeneration: () => 0,
    isGenerationCurrent,
    isSessionStopping,
  };
  const workspaceBridge = {
    markSessionRunning: vi.fn(() => 1),
    markSessionIdle: vi.fn(),
    recordRatchetSessionEnd: vi.fn(async () => undefined),
    resetPRDiscoveryBackoff: vi.fn(async () => true),
  };
  const service = new SessionService({
    runtimeManager: runtimeManager as never,
    sessionDomainService: sessionDomainService as never,
    acpEventProcessor: acpEventProcessor as never,
    promptTurnCompletionService: promptTurnCompletionService as never,
    lifecycleEventService: lifecycleEventService as never,
    lifecycleGate,
  });
  service.configure({ workspace: workspaceBridge });

  return {
    service,
    runtimeManager,
    sessionDomainService,
    acpEventProcessor,
    lifecycleEventService,
    promptTurnCompletionService,
    isSessionStopping,
    isGenerationCurrent,
    workspaceBridge,
  };
}

function startTool(acpEventProcessor: AcpEventProcessor, id: string, command: string) {
  acpEventProcessor.handleAcpDelta('session-1', {
    type: 'agent_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name: 'Bash', input: { command } },
      },
    },
  });
}

function completeTool(acpEventProcessor: AcpEventProcessor, id: string) {
  acpEventProcessor.handleAcpDelta('session-1', {
    type: 'agent_message',
    data: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    },
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it('keeps preview details while becoming idle after a prompt and wakes queued prompts', async () => {
  const { service, runtimeManager, sessionDomainService, promptTurnCompletionService } =
    createPromptService();
  const tracker = new AcpNativeSessionTracker({
    onTaskStatusChanged: (active) => runtimeManager.isSessionWorking.mockReturnValue(active),
  });
  tracker.onRawMessage({
    method: 'session/update',
    params: {
      sessionId: 'root',
      update: {
        sessionUpdate: 'async_task_spawned',
        asyncTaskId: 'preview',
        name: 'pnpm storybook',
        taskType: 'shell',
      },
    },
  });
  runtimeManager.getClient.mockReturnValue({
    supportsImages: () => true,
    isPromptInFlight: false,
    nativeSessionTracker: tracker,
  });
  runtimeManager.sendPrompt.mockResolvedValue({ stopReason: 'end_turn' });

  await service.sendSessionMessage('session-1', 'follow-up');

  expect(sessionDomainService.setRuntimeSnapshot).toHaveBeenLastCalledWith(
    'session-1',
    expect.objectContaining({
      phase: 'idle',
      activity: 'IDLE',
      processState: 'alive',
      work: {
        promptInFlight: false,
        backgroundTasks: [{ id: '["root","preview"]', name: 'pnpm storybook', kind: 'shell' }],
        runningSubagents: 0,
        activeGoals: 0,
      },
    })
  );
  expect(sessionDomainService.setRuntimeSnapshot.mock.calls[0]?.[1].work.promptInFlight).toBe(true);
  expect(promptTurnCompletionService.schedule).toHaveBeenCalledWith('session-1');
});

function createLifecyclePromptHarness() {
  const runtimeManager = {
    getClient: vi.fn().mockReturnValue({ supportsImages: () => true }),
    isSessionWorking: vi.fn().mockReturnValue(true),
    isSessionPromptInFlight: vi.fn().mockReturnValue(true),
    sendPrompt: vi.fn(),
  };
  const sessionDomainService = new SessionDomainService();
  const lifecycleEvents = new Map<string, Record<string, unknown>>();
  const lifecycleStore = {
    upsert: vi.fn((input: { dedupeKey: string }) => {
      const existing = lifecycleEvents.get(input.dedupeKey);
      if (existing) {
        return existing;
      }
      const event = { ...input, id: 'event-1' };
      lifecycleEvents.set(input.dedupeKey, event);
      return event;
    }),
  };
  const lifecycleEventService = new SessionLifecycleEventService({
    store: lifecycleStore as never,
    sessionDomainService,
  });
  const acpEventProcessor = new AcpEventProcessor({
    runtimeManager: runtimeManager as never,
    sessionDomainService,
    sessionPermissionService: {
      createPermissionBridge: vi.fn(),
      handlePermissionRequest: vi.fn(),
    } as never,
    sessionConfigService: { applyConfigOptionsUpdateDelta: vi.fn() } as never,
    onToolCallTimeout: vi.fn(),
  });
  acpEventProcessor.registerSessionContext('session-1', {
    workspaceId: 'workspace-1',
    workingDir: '/workspace',
    provider: 'CODEX',
  });
  const service = new SessionService({
    runtimeManager: runtimeManager as never,
    sessionDomainService,
    acpEventProcessor,
    promptTurnCompletionService: { schedule: vi.fn() } as never,
    lifecycleEventService,
    lifecycleGate: {
      getGeneration: () => 0,
      isGenerationCurrent: (_sessionId, stopGeneration) => stopGeneration === 0,
      isSessionStopping: () => false,
    },
  });

  return {
    service,
    runtimeManager,
    sessionDomainService,
    lifecycleEvents,
    lifecycleStore,
    acpEventProcessor,
  };
}

describe('SessionService prompt coordination', () => {
  it('keeps fresh background work when a prompt fails while its runtime remains alive', async () => {
    const { service, runtimeManager, sessionDomainService } = createLifecyclePromptHarness();
    const tracker = new AcpNativeSessionTracker();
    tracker.onRawMessage({
      method: 'session/update',
      params: {
        sessionId: 'root',
        update: {
          sessionUpdate: 'async_task_spawned',
          asyncTaskId: 'preview',
          name: 'pnpm storybook',
          taskType: 'shell',
        },
      },
    });
    runtimeManager.getClient.mockReturnValue(
      Object.assign(
        { supportsImages: () => true },
        {
          isPromptInFlight: false,
          nativeSessionTracker: tracker,
        }
      )
    );
    runtimeManager.sendPrompt.mockRejectedValue(new Error('Provider failed'));
    await expect(service.sendSessionMessage('session-1', 'follow-up')).rejects.toThrow(
      'Provider failed'
    );
    expect(sessionDomainService.getRuntimeSnapshot('session-1')).toMatchObject({
      phase: 'error',
      processState: 'alive',
      errorMessage: 'Provider failed',
      work: { promptInFlight: false, backgroundTasks: [{ name: 'pnpm storybook', kind: 'shell' }] },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('makes PR discovery eligible after each successful turn while the ACP process stays alive', async () => {
    const { service, runtimeManager, workspaceBridge } = createPromptService();
    const prompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt.mockReturnValueOnce(prompt.promise);
    const pending = service.sendSessionMessage('session-1', 'open a PR');
    await Promise.resolve();
    expect(workspaceBridge.resetPRDiscoveryBackoff).not.toHaveBeenCalled();

    // A pending database write must not delay completion or the next queued turn.
    const reset = createDeferred<boolean>();
    workspaceBridge.resetPRDiscoveryBackoff.mockReturnValueOnce(reset.promise);
    prompt.resolve({ stopReason: 'end_turn' });
    await expect(pending).resolves.toBeUndefined();
    expect(workspaceBridge.resetPRDiscoveryBackoff).toHaveBeenCalledExactlyOnceWith('workspace-1');
    reset.resolve(true);

    runtimeManager.sendPrompt.mockResolvedValueOnce({ stopReason: 'end_turn' });
    await service.sendSessionMessage('session-1', 'push changes');
    expect(workspaceBridge.resetPRDiscoveryBackoff).toHaveBeenCalledTimes(2);
  });

  it('preserves successful turn completion when discovery scheduling fails', async () => {
    const { service, runtimeManager, workspaceBridge, promptTurnCompletionService } =
      createPromptService();
    runtimeManager.sendPrompt.mockResolvedValueOnce({ stopReason: 'end_turn' });
    workspaceBridge.resetPRDiscoveryBackoff.mockRejectedValueOnce(
      new Error('database unavailable')
    );

    await expect(service.sendSessionMessage('session-1', '')).resolves.toBeUndefined();
    expect(workspaceBridge.resetPRDiscoveryBackoff).toHaveBeenCalledWith('workspace-1');
    expect(promptTurnCompletionService.schedule).toHaveBeenCalledWith('session-1');
  });

  it.each(['stopping', 'stale', 'failed', 'busy', 'unowned'] as const)(
    'does not reset discovery for a %s turn',
    async (scenario) => {
      const harness = createPromptService();
      const { service, runtimeManager, workspaceBridge } = harness;
      runtimeManager.sendPrompt.mockResolvedValueOnce({ stopReason: 'end_turn' });
      if (scenario === 'stopping') {
        harness.isSessionStopping.mockReturnValue(true);
      }
      if (scenario === 'stale') {
        harness.isGenerationCurrent.mockReturnValue(false);
      }
      if (scenario === 'unowned') {
        harness.acpEventProcessor.getWorkspaceId.mockReturnValue(undefined);
      }
      if (scenario === 'failed' || scenario === 'busy') {
        runtimeManager.sendPrompt
          .mockReset()
          .mockRejectedValueOnce(
            new Error(
              scenario === 'busy' ? 'A turn is already in progress for this session' : 'failed'
            )
          );
        await expect(service.sendSessionMessage('session-1', '')).rejects.toThrow();
      } else {
        await service.sendSessionMessage('session-1', '');
      }
      expect(workspaceBridge.resetPRDiscoveryBackoff).not.toHaveBeenCalled();
    }
  );

  it('rejects when sendSessionMessage is called without an ACP client', async () => {
    const { service, runtimeManager } = createPromptService();
    runtimeManager.getClient.mockReturnValue(undefined);

    await expect(service.sendSessionMessage('session-1', 'hello')).rejects.toThrow(
      'No ACP client found for sendSessionMessage: session-1'
    );
    expect(runtimeManager.sendPrompt).not.toHaveBeenCalled();
  });

  it('converts supported content into ACP blocks', async () => {
    const { service, runtimeManager } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.sendPrompt.mockResolvedValue({ stopReason: 'end_turn' });

    await service.sendSessionMessage('session-1', [
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'analyzing' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      { type: 'tool_result', content: 'tool output' },
      { type: 'tool_result', content: { ok: true } },
      { type: 'unsupported' } as never,
    ] as never);

    expect(runtimeManager.sendPrompt).toHaveBeenCalledWith(
      'session-1',
      [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'analyzing' },
        { type: 'image', data: 'abc', mimeType: 'image/png' },
        { type: 'text', text: 'tool output' },
        { type: 'text', text: '{"ok":true}' },
      ],
      14_400_000
    );
  });

  it('uses a text placeholder when the provider does not support images', async () => {
    const { service, runtimeManager } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => false });
    runtimeManager.sendPrompt.mockResolvedValue({ stopReason: 'end_turn' });

    await service.sendSessionMessage('session-1', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ] as never);

    expect(runtimeManager.sendPrompt).toHaveBeenCalledWith(
      'session-1',
      [{ type: 'text', text: '[Image: not supported by this provider]' }],
      14_400_000
    );
  });

  it('uses the four-hour deadline for normal user messages', async () => {
    const { service, runtimeManager } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.sendPrompt.mockResolvedValue({ stopReason: 'end_turn' });

    await service.sendSessionMessage('session-1', 'continue');

    expect(runtimeManager.sendPrompt).toHaveBeenCalledWith(
      'session-1',
      [{ type: 'text', text: 'continue' }],
      14_400_000
    );
  });

  it('records one durable timeout event for the active attempt', async () => {
    const { service, runtimeManager, lifecycleEventService } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.sendPrompt.mockRejectedValue(new PromptTimeoutError('session-1', 14_400_000));

    await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow();

    expect(lifecycleEventService.record).toHaveBeenCalledOnce();
    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        kind: 'TURN_INTERRUPTED',
        reason: 'PROMPT_TIMEOUT',
        message: 'Turn stopped: reached the 4-hour limit.',
        dedupeKey: expect.stringMatching(/^turn:.+:stop$/),
      })
    );
  });

  it('ends a failed turn in the error state even when background activity remains', async () => {
    const {
      service,
      runtimeManager,
      sessionDomainService,
      lifecycleEventService,
      workspaceBridge,
    } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.isSessionWorking.mockReturnValue(true);
    runtimeManager.sendPrompt.mockRejectedValue(
      new Error('Selected model is at capacity. Please try a different model.')
    );

    await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow(
      'at capacity'
    );

    expect(sessionDomainService.setRuntimeSnapshot).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({ phase: 'error', activity: 'IDLE', processState: 'alive' })
    );
    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'PROVIDER_ERROR',
        kind: 'TURN_INTERRUPTED',
        message: 'Turn stopped: the selected model is at capacity. Please try a different model.',
      })
    );
    expect(workspaceBridge.markSessionIdle).toHaveBeenCalledWith('workspace-1', 'session-1', 1);
  });

  it('preserves a useful HTTP 529 overload reason', async () => {
    const { service, runtimeManager, lifecycleEventService } = createPromptService();
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.sendPrompt.mockRejectedValue(new Error('HTTP 529: Overloaded'));

    await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow();

    expect(lifecycleEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'PROVIDER_ERROR',
        message: 'Turn stopped: Codex returned HTTP 529 (Overloaded).',
      })
    );
  });

  it('does not record prompt cancellation after an explicit stop began', async () => {
    const { service, runtimeManager, lifecycleEventService, isSessionStopping } =
      createPromptService();
    isSessionStopping.mockReturnValue(true);
    runtimeManager.getClient.mockReturnValue({ supportsImages: () => true });
    runtimeManager.sendPrompt.mockRejectedValue(new Error('Prompt cancelled'));

    await expect(service.sendSessionMessage('session-1', 'continue')).rejects.toThrow();

    expect(lifecycleEventService.record).not.toHaveBeenCalled();
  });

  it('records the prompt timeout when ACP emits an error before rejection', async () => {
    const {
      service,
      runtimeManager,
      sessionDomainService,
      lifecycleEvents,
      lifecycleStore,
      acpEventProcessor,
    } = createLifecyclePromptHarness();
    const prompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt.mockReturnValue(prompt.promise);

    const pending = service.sendSessionMessage('session-1', 'continue');
    await vi.waitFor(() => expect(runtimeManager.sendPrompt).toHaveBeenCalledOnce());
    acpEventProcessor.handleAcpDelta('session-1', {
      type: 'agent_message',
      data: { type: 'error', error: 'HTTP 529: Overloaded' },
    });
    prompt.reject(new PromptTimeoutError('session-1', 14_400_000));

    await expect(pending).rejects.toThrow(PromptTimeoutError);
    await vi.waitFor(() => {
      expect(
        sessionDomainService
          .getTranscriptSnapshot('session-1')
          .filter((entry) => entry.message?.type === 'session_lifecycle')
      ).toHaveLength(1);
    });
    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleStore.upsert).toHaveBeenCalledOnce();
    expect([...lifecycleEvents.values()][0]).toMatchObject({
      reason: 'PROMPT_TIMEOUT',
      message: 'Turn stopped: reached the 4-hour limit.',
    });
  });

  it('does not record an ACP busy-turn error before the matching rejection', async () => {
    const { service, runtimeManager, lifecycleEvents, lifecycleStore, acpEventProcessor } =
      createLifecyclePromptHarness();
    const prompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt.mockReturnValue(prompt.promise);

    const pending = service.sendSessionMessage('session-1', 'continue');
    await vi.waitFor(() => expect(runtimeManager.sendPrompt).toHaveBeenCalledOnce());
    acpEventProcessor.handleAcpDelta('session-1', {
      type: 'agent_message',
      data: { type: 'error', error: 'A turn is already in progress for this session' },
    });
    prompt.reject(new Error('A turn is already in progress for this session'));

    await expect(pending).rejects.toThrow('A turn is already in progress for this session');
    expect(lifecycleEvents).toHaveLength(0);
    expect(lifecycleStore.upsert).not.toHaveBeenCalled();
  });

  it.each([
    'password=hunter2',
    'cookie=session%3Dprivate',
    'Bearer private-token',
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature',
    'https://martin:supersecret@example.com/api',
    '/Users/martin/private/prompt.txt: failed on customer@example.com',
  ])('sanitizes ACP error details without interrupting a successful turn: %s', async (error) => {
    const { service, runtimeManager, sessionDomainService, lifecycleEvents, acpEventProcessor } =
      createLifecyclePromptHarness();
    const prompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt.mockReturnValue(prompt.promise);

    const pending = service.sendSessionMessage('session-1', 'continue');
    await vi.waitFor(() => expect(runtimeManager.sendPrompt).toHaveBeenCalledOnce());
    acpEventProcessor.handleAcpDelta('session-1', {
      type: 'agent_message',
      data: { type: 'error', error },
    });
    prompt.resolve({ stopReason: 'end_turn' });

    await expect(pending).resolves.toBeUndefined();
    const transcript = sessionDomainService.getTranscriptSnapshot('session-1');
    const persisted = JSON.stringify({
      transcript,
      lifecycleEvents: [...lifecycleEvents.values()],
    });
    expect(persisted).not.toContain(error);
    expect(lifecycleEvents).toHaveLength(0);
    expect(transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            type: 'error',
            error: 'The provider returned an error.',
          }),
        }),
      ])
    );
    expect(
      transcript
        .flatMap((entry) => [entry.message?.error, entry.message?.lifecycle?.message])
        .filter((message): message is string => typeof message === 'string')
        .every((message) => message.length <= 240)
    ).toBe(true);
  });

  it('serializes concurrent ACP prompts with the four-hour deadline for the queued turn', async () => {
    const { service, runtimeManager } = createPromptService();
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const secondPrompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const first = service.sendSessionMessage('session-1', 'first');
    await Promise.resolve();
    const second = service.sendSessionMessage('session-1', 'second');
    await Promise.resolve();

    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(1);

    firstPrompt.resolve({ stopReason: 'end_turn' });
    await expect(first).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(2);
    });

    expect(runtimeManager.sendPrompt).toHaveBeenNthCalledWith(
      2,
      'session-1',
      [{ type: 'text', text: 'second' }],
      14_400_000
    );

    secondPrompt.resolve({ stopReason: 'end_turn' });
    await expect(second).resolves.toBeUndefined();
  });

  it('does not serialize ACP prompts across sessions', async () => {
    const { service, runtimeManager } = createPromptService();
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const secondPrompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const first = service.sendSessionMessage('session-1', 'first');
    const second = service.sendSessionMessage('session-2', 'second');
    await Promise.resolve();

    expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(2);

    firstPrompt.resolve({ stopReason: 'end_turn' });
    secondPrompt.resolve({ stopReason: 'end_turn' });
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it('continues a session prompt queue after a prompt fails', async () => {
    const { service, runtimeManager } = createPromptService();
    const firstPrompt = createDeferred<{ stopReason: string }>();
    const secondPrompt = createDeferred<{ stopReason: string }>();
    runtimeManager.sendPrompt
      .mockImplementationOnce(() => firstPrompt.promise)
      .mockImplementationOnce(() => secondPrompt.promise);

    const first = service.sendSessionMessage('session-1', 'first');
    const second = service.sendSessionMessage('session-1', 'second');

    firstPrompt.reject(new Error('prompt failed'));
    await expect(first).rejects.toThrow('prompt failed');
    await vi.waitFor(() => {
      expect(runtimeManager.sendPrompt).toHaveBeenCalledTimes(2);
    });

    secondPrompt.resolve({ stopReason: 'end_turn' });
    await expect(second).resolves.toBeUndefined();
  });

  it('does not report tool calls that predate an accepted prompt as its orphans', async () => {
    const { service, runtimeManager, acpEventProcessor, sessionDomainService } =
      createLifecyclePromptHarness();
    const notifyToolStart = vi
      .spyOn(interceptorRegistry, 'notifyToolStart')
      .mockImplementation(() => undefined);
    try {
      startTool(acpEventProcessor, 'tool-1', 'pnpm test');
      const appendClaudeEvent = vi.spyOn(sessionDomainService, 'appendClaudeEvent');
      runtimeManager.sendPrompt.mockResolvedValueOnce({ stopReason: 'end_turn' });

      await service.sendSessionMessage('session-1', 'follow-up');

      expect(appendClaudeEvent).not.toHaveBeenCalled();
      expect(acpEventProcessor.pendingAcpToolCalls.has('session-1')).toBe(false);
    } finally {
      notifyToolStart.mockRestore();
    }
  });

  describe('when the provider already has a turn in progress', () => {
    const busy = 'A turn is already in progress for this session';

    it('keeps the running turn tool-call metadata for interceptors', async () => {
      const { service, runtimeManager, acpEventProcessor } = createLifecyclePromptHarness();
      const notifyToolComplete = vi
        .spyOn(interceptorRegistry, 'notifyToolComplete')
        .mockImplementation(() => undefined);
      const notifyToolStart = vi
        .spyOn(interceptorRegistry, 'notifyToolStart')
        .mockImplementation(() => undefined);
      try {
        startTool(acpEventProcessor, 'tool-1', 'gh pr create --fill');
        runtimeManager.sendPrompt.mockRejectedValueOnce(new Error(busy));
        await expect(service.sendSessionMessage('session-1', 'follow-up')).rejects.toThrow(busy);

        completeTool(acpEventProcessor, 'tool-1');

        expect(notifyToolComplete).toHaveBeenCalledWith(
          expect.objectContaining({
            toolUseId: 'tool-1',
            toolName: 'Bash',
            input: { command: 'gh pr create --fill' },
          }),
          expect.anything()
        );
      } finally {
        notifyToolComplete.mockRestore();
        notifyToolStart.mockRestore();
      }
    });

    it('does not finalize the running turn tool calls as orphans', async () => {
      const { service, runtimeManager, acpEventProcessor, sessionDomainService } =
        createLifecyclePromptHarness();
      const notifyToolStart = vi
        .spyOn(interceptorRegistry, 'notifyToolStart')
        .mockImplementation(() => undefined);
      try {
        startTool(acpEventProcessor, 'tool-1', 'pnpm test');
        const appendClaudeEvent = vi.spyOn(sessionDomainService, 'appendClaudeEvent');
        runtimeManager.sendPrompt.mockRejectedValueOnce(new Error(busy));
        await expect(service.sendSessionMessage('session-1', 'follow-up')).rejects.toThrow(busy);

        expect(appendClaudeEvent).not.toHaveBeenCalled();
        expect(acpEventProcessor.pendingAcpToolCalls.get('session-1')?.has('tool-1')).toBe(true);
        expect(acpEventProcessor.getActivePromptAttemptKey('session-1')).toBeUndefined();
      } finally {
        notifyToolStart.mockRestore();
      }
    });
  });
});
