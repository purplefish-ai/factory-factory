import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { AcpRuntimeConfigController } from '@/backend/services/session/service/acp/acp-runtime-config-controller';
import {
  createDeferred,
  createTestProcessHandle,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { DEFAULT_THINKING_BUDGET, type SessionDeltaEvent } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

function options(model: string): SessionConfigOption[] {
  return [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: ['first', 'second', 'third'].map((value) => ({ value, name: value })),
    },
    {
      id: 'mode',
      category: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: 'workspace-write',
      options: [{ value: 'workspace-write', name: 'Workspace write' }],
    },
  ];
}
function fixture() {
  const rpc = vi.fn();
  const handle = createTestProcessHandle({
    provider: 'CODEX',
    providerSessionId: 'thread',
    connection: { setSessionConfigOption: rpc },
  });
  handle.configOptions = options('first');
  const handles = new Map([['session', handle]]);
  const controller = new AcpRuntimeConfigController();
  const runtime = {
    getClient: vi.fn((id: string) => handles.get(id)),
    isStopInProgress: vi.fn(() => false),
    setSessionModel: vi.fn((id: string, value: string) =>
      controller.setSessionModel(handles.get(id) ?? handle, value, id)
    ),
    setConfigOption: vi.fn((id: string, configId: string, value: string) =>
      controller.setConfigOption(handles.get(id) ?? handle, configId, value, id)
    ),
  };
  const session = {
    id: 'session',
    provider: 'CODEX',
    providerSessionId: 'thread',
    workflow: 'code',
    providerMetadata: null,
    model: 'first',
  };
  const persisted: string[] = [];
  const repository = {
    getSessionById: vi.fn().mockResolvedValue(session),
    updateSession: vi.fn((_id: string, update: { model?: string }) => {
      if (update.model) {
        persisted.push(update.model);
      }
      return Promise.resolve(Object.assign(session, update));
    }),
  };
  const emitted: string[] = [];
  const domain = {
    emitDelta: vi.fn((_id: string, event: SessionDeltaEvent) => {
      if (event.type === 'config_options_update') {
        emitted.push(
          String(event.configOptions.find((option) => option.id === 'model')?.currentValue)
        );
      }
    }),
  };
  const service = new SessionConfigService({
    repository: unsafeCoerce(repository),
    runtimeManager: unsafeCoerce(runtime),
    codexModelCatalogService: { getModels: vi.fn() },
    sessionDomainService: unsafeCoerce(domain),
  });
  return {
    service,
    handle,
    handles,
    rpc,
    runtime,
    repository,
    domain,
    session,
    persisted,
    emitted,
  };
}

describe('configuration transaction ordering', () => {
  it('gives newer native edits precedence over an already queued message', async () => {
    const f = fixture();
    const queued = {
      timestamp: new Date(0).toISOString(),
      settings: {
        selectedModel: 'first',
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    };
    f.handle.isPromptInFlight = true;
    f.rpc.mockResolvedValue({ configOptions: options('second') });
    const edit = f.service.setSessionConfigOption('session', 'model', 'second');
    const resolved = f.service.configureQueuedMessage('session', queued);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.rpc).not.toHaveBeenCalled();
    f.handle.isPromptInFlight = false;
    await edit;
    expect((await resolved).selectedModel).toBe('second');
    const newer = { ...queued, timestamp: new Date(Date.now() + 1000).toISOString() };
    expect((await f.service.configureQueuedMessage('session', newer)).selectedModel).toBe('first');
  });

  it('keeps edits arriving during dispatch configuration after the complete message transaction', async () => {
    const f = fixture();
    const planning = (model: string): SessionConfigOption[] => [
      ...options(model),
      {
        id: 'collaboration_mode',
        category: 'collaboration_mode',
        name: 'Planning',
        type: 'select',
        currentValue: 'plan',
        options: [
          { value: 'plan', name: 'Plan' },
          { value: 'default', name: 'Default' },
        ],
      },
    ];
    f.handle.configOptions = planning('first').map((option) =>
      option.id === 'collaboration_mode' && option.type === 'select'
        ? { ...option, currentValue: 'default' }
        : option
    );
    const plan = createDeferred<{ configOptions: SessionConfigOption[] }>();
    f.rpc
      .mockReturnValueOnce(plan.promise)
      .mockResolvedValueOnce({ configOptions: planning('first') })
      .mockResolvedValueOnce({ configOptions: planning('third') });
    const configuring = f.service.configureQueuedMessage('session', {
      timestamp: new Date(0).toISOString(),
      settings: {
        selectedModel: 'first',
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: true,
      },
    });
    // Force the plan write to yield before the message's model write.
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalled());
    const edit = f.service.setSessionConfigOption('session', 'model', 'third');
    plan.resolve({ configOptions: planning('first') });
    await Promise.all([configuring, edit]);
    expect(f.rpc.mock.calls.map(([request]) => [request.configId, request.value])).toEqual([
      ['collaboration_mode', 'plan'],
      ['model', 'first'],
      ['model', 'third'],
    ]);
    expect(f.handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
      'third'
    );
  });

  it.each([true, false])(
    'preserves a newer explicit thinking toggle %s over queued intent',
    async (enabled) => {
      const f = fixture();
      const budget = String(DEFAULT_THINKING_BUDGET);
      const thought: SessionConfigOption = {
        id: 'thinking_budget',
        category: 'thought_level',
        name: 'Thinking',
        type: 'select',
        currentValue: budget,
        options: [{ value: budget, name: budget }],
      };
      f.handle.configOptions.push(thought);
      f.rpc.mockResolvedValue({ configOptions: [...options('first'), thought] });
      await f.service.setSessionThinkingBudget('session', enabled ? DEFAULT_THINKING_BUDGET : null);
      const resolved = await f.service.configureQueuedMessage(
        'session',
        {
          timestamp: new Date(0).toISOString(),
          settings: {
            selectedModel: null,
            reasoningEffort: null,
            thinkingEnabled: !enabled,
            planModeEnabled: false,
          },
        },
        true
      );
      expect(resolved.thinkingEnabled).toBe(enabled);
      expect(
        f.rpc.mock.calls.filter(([request]) => request.configId === 'thinking_budget')
      ).toHaveLength(enabled ? 2 : 0);
    }
  );

  it('does not capture unsupported thinking budgets as successful toggles', async () => {
    const f = fixture();
    f.handle.configOptions.push({
      id: 'thinking_budget',
      category: 'thought_level',
      name: 'Thinking',
      type: 'select',
      currentValue: 'low',
      options: [{ value: 'low', name: 'Low' }],
    });
    await f.service.setSessionThinkingBudget('session', DEFAULT_THINKING_BUDGET);
    const resolved = await f.service.configureQueuedMessage(
      'session',
      {
        timestamp: new Date(0).toISOString(),
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      },
      true
    );
    expect(resolved.thinkingEnabled).toBe(false);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('keeps a queued model choice after a reasoning-only user request', async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ configOptions: options('second') });
    await f.service.setSessionModel('session', undefined, 'user');
    const resolved = await f.service.configureQueuedMessage('session', {
      timestamp: new Date(0).toISOString(),
      settings: {
        selectedModel: 'second',
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    expect(resolved.selectedModel).toBe('second');
    expect(f.rpc).toHaveBeenCalledWith(
      expect.objectContaining({ configId: 'model', value: 'second' })
    );
  });

  it('retains the latest choice when provider responses would complete in reverse order', async () => {
    const f = fixture();
    const second = createDeferred<{ configOptions: SessionConfigOption[] }>();
    const third = createDeferred<{ configOptions: SessionConfigOption[] }>();
    f.rpc.mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    const selectingSecond = f.service.setSessionConfigOption('session', 'model', 'second');
    const selectingThird = f.service.setSessionConfigOption('session', 'model', 'third');
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalled());
    third.resolve({ configOptions: options('third') });
    await Promise.resolve();
    await Promise.resolve();
    second.resolve({ configOptions: options('second') });
    await Promise.all([selectingSecond, selectingThird]);
    expect(f.handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
      'third'
    );
    expect(f.persisted).toEqual(['second', 'third']);
    expect(f.emitted).toEqual(['second', 'third']);
  });

  it('waits for persistence and publication before sending the next configuration RPC', async () => {
    const f = fixture();
    const persisting = createDeferred<typeof f.session>();
    f.repository.updateSession.mockReturnValueOnce(persisting.promise);
    f.rpc
      .mockResolvedValueOnce({ configOptions: options('second') })
      .mockResolvedValueOnce({ configOptions: options('third') });
    const selectingSecond = f.service.setSessionConfigOption('session', 'model', 'second');
    const selectingThird = f.service.setSessionConfigOption('session', 'model', 'third');
    await vi.waitFor(() => expect(f.repository.updateSession).toHaveBeenCalled());
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.emitted).toEqual([]);
    persisting.resolve(f.session);
    await Promise.all([selectingSecond, selectingThird]);
    expect(f.emitted).toEqual(['second', 'third']);
  });

  it('does not block other sessions behind a stalled configuration RPC', async () => {
    const f = fixture();
    const stalled = createDeferred<{ configOptions: SessionConfigOption[] }>();
    const other = createTestProcessHandle({
      provider: 'CODEX',
      providerSessionId: 'other-thread',
      connection: { setSessionConfigOption: f.rpc },
    });
    other.configOptions = options('first');
    f.handles.set('other', other);
    f.rpc
      .mockReturnValueOnce(stalled.promise)
      .mockResolvedValueOnce({ configOptions: options('third') });
    const first = f.service.setSessionConfigOption('session', 'model', 'second');
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce());
    await f.service.setSessionConfigOption('other', 'model', 'third');
    expect(other.configOptions.find((option) => option.id === 'model')?.currentValue).toBe('third');
    stalled.resolve({ configOptions: options('second') });
    await first;
  });

  it('serializes reasoning writes with model writes that replace the complete snapshot', async () => {
    const f = fixture();
    const reasoning = (value: string): SessionConfigOption => ({
      id: 'reasoning_effort',
      category: 'thought_level',
      name: 'Reasoning',
      type: 'select',
      currentValue: value,
      options: ['low', 'high'].map((entry) => ({ value: entry, name: entry })),
    });
    f.handle.configOptions = [...options('first'), reasoning('high')];
    const model = createDeferred<{ configOptions: SessionConfigOption[] }>();
    const effort = createDeferred<{ configOptions: SessionConfigOption[] }>();
    f.rpc.mockReturnValueOnce(model.promise).mockReturnValueOnce(effort.promise);
    const changingModel = f.service.setSessionConfigOption('session', 'model', 'second');
    const changingEffort = f.service.setSessionReasoningEffort('session', 'low');
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalled());
    effort.resolve({ configOptions: [...options('second'), reasoning('low')] });
    await Promise.resolve();
    model.resolve({ configOptions: [...options('second'), reasoning('high')] });
    await Promise.all([changingModel, changingEffort]);
    expect(
      f.handle.configOptions.find((option) => option.id === 'reasoning_effort')?.currentValue
    ).toBe('low');
    expect(f.emitted).toEqual(['second', 'second']);
  });

  it.each(['stop', 'replacement'])('rejects queued edits after runtime %s', async (transition) => {
    const f = fixture();
    const first = createDeferred<{ configOptions: SessionConfigOption[] }>();
    f.rpc.mockReturnValueOnce(first.promise);
    const results = Promise.allSettled([
      f.service.setSessionConfigOption('session', 'model', 'second'),
      f.service.setSessionConfigOption('session', 'model', 'third'),
    ]);
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce());
    if (transition === 'stop') {
      f.runtime.isStopInProgress.mockReturnValue(true);
    } else {
      f.handles.set('session', createTestProcessHandle());
    }
    first.reject(new Error('Provider no longer available'));
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.repository.updateSession).not.toHaveBeenCalled();
    expect(f.emitted).toEqual([]);
  });

  it('keeps the new model native reasoning default when the previous effort is unsupported', async () => {
    const f = fixture();
    f.handle.configOptions = [
      ...options('first'),
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        name: 'Reasoning',
        type: 'select',
        currentValue: 'high',
        options: ['low', 'high'].map((value) => ({ value, name: value })),
      },
    ];
    f.rpc.mockResolvedValue({
      configOptions: [
        ...options('third'),
        {
          id: 'reasoning_effort',
          category: 'thought_level',
          name: 'Reasoning',
          type: 'select',
          currentValue: 'low',
          options: [{ value: 'low', name: 'Low' }],
        },
      ],
    });
    await f.service.setSessionModel('session', 'third');
    await f.service.setSessionReasoningEffort('session', 'high');
    expect(f.rpc).toHaveBeenCalledOnce();
    expect(
      f.handle.configOptions.find((option) => option.id === 'reasoning_effort')?.currentValue
    ).toBe('low');
  });

  it('continues the queue after a rejected provider mutation', async () => {
    const f = fixture();
    f.rpc
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({ configOptions: options('third') });
    const results = await Promise.allSettled([
      f.service.setSessionConfigOption('session', 'model', 'second'),
      f.service.setSessionConfigOption('session', 'model', 'third'),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(f.emitted).toEqual(['first', 'third']);
    expect(f.domain.emitDelta.mock.invocationCallOrder[0]).toBeLessThan(
      f.runtime.setSessionModel.mock.invocationCallOrder[1] ?? 0
    );
  });
});
