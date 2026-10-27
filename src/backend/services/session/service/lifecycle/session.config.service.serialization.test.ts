import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { AcpRuntimeConfigController } from '@/backend/services/session/service/acp/acp-runtime-config-controller';
import {
  createDeferred,
  createTestProcessHandle,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import type { SessionDeltaEvent } from '@/shared/acp-protocol';
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
