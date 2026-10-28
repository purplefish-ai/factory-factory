import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { userSettingsService } from '@/backend/services/settings';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';
vi.mock('@/backend/services/settings', () => ({ userSettingsService: { get: vi.fn() } }));
function fixture(metadata: unknown) {
  const handle = createTestProcessHandle({ provider: 'CODEX', providerSessionId: 'thread' });
  handle.configOptions = [
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      name: 'Reasoning',
      type: 'select',
      currentValue: 'low',
      options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
    },
  ];
  const session = unsafeCoerce<AgentSessionRecord>({
    id: 'session',
    provider: 'CODEX',
    providerSessionId: 'thread',
    workflow: 'followup',
    model: 'model',
    providerMetadata: metadata,
  });
  const runtime = {
    getClient: vi.fn<() => AcpProcessHandle | undefined>(() => handle),
    isStopInProgress: vi.fn(() => false),
    setConfigOption: vi.fn((_id: string, configId: string, value: string) => {
      handle.configOptions = handle.configOptions.map((option) =>
        option.type === 'select' && option.id === configId
          ? { ...option, currentValue: value }
          : option
      );
      return Promise.resolve(handle.configOptions);
    }),
  };
  const repository = {
    getSessionById: vi.fn().mockResolvedValue(session),
    updateSession: vi.fn((_id: string, update: object) =>
      Promise.resolve(Object.assign(session, update))
    ),
  };
  const service = new SessionConfigService({
    repository: unsafeCoerce(repository),
    runtimeManager: unsafeCoerce(runtime),
    codexModelCatalogService: { getModels: vi.fn() },
    sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
  });
  return { service, session, handle, runtime };
}
function saved(reasoning: string): SessionConfigOption[] {
  return [
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      name: 'Reasoning',
      type: 'select',
      currentValue: reasoning,
      options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
    },
  ];
}
describe('startup thinking intent precedence', () => {
  beforeEach(() =>
    vi
      .mocked(userSettingsService.get)
      .mockResolvedValue(unsafeCoerce({ defaultCodexReasoningEffort: 'high' }))
  );
  it.each(['medium', null] as const)(
    'applies explicit launch effort %s instead of current global defaults',
    async (effort) => {
      const f = fixture({ launchSettings: { reasoningEffort: effort, applied: false } });
      await f.service.applyConfiguredReasoningEffort('session', f.handle, {
        session: f.session,
        persistSnapshot: false,
        emitUpdates: false,
      });
      expect(f.handle.configOptions[0]?.currentValue).toBe(effort ?? 'low');
    }
  );
  it('rejects an explicit unsupported level before readiness instead of silently defaulting', async () => {
    const f = fixture({ launchSettings: { reasoningEffort: 'max', applied: false } });
    await expect(
      f.service.applyConfiguredReasoningEffort('session', f.handle, { session: f.session })
    ).rejects.toThrow('Unsupported reasoning');
  });
  it('restores the latest confirmed effort ahead of stale launch intent and global defaults', async () => {
    const f = fixture({
      launchSettings: { reasoningEffort: 'low', applied: true },
      acpConfigSnapshot: {
        provider: 'CODEX',
        providerSessionId: 'thread',
        configOptions: saved('medium'),
      },
    });
    await f.service.applyConfiguredReasoningEffort('session', f.handle, {
      session: f.session,
      persistSnapshot: false,
      emitUpdates: false,
    });
    expect(f.handle.configOptions[0]?.currentValue).toBe('medium');
  });
  it('does not let an intermediate snapshot consume unapplied launch intent', async () => {
    const f = fixture({
      launchSettings: { reasoningEffort: 'medium', applied: false },
      acpConfigSnapshot: {
        provider: 'CODEX',
        providerSessionId: 'thread',
        configOptions: saved('low'),
      },
    });
    await f.service.applyConfiguredReasoningEffort('session', f.handle, {
      session: f.session,
      persistSnapshot: false,
      emitUpdates: false,
    });
    expect(f.handle.configOptions[0]?.currentValue).toBe('medium');
  });
  it('normalizes an old effort after a supported stopped-session model edit', async () => {
    const model: SessionConfigOption = {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'first',
      options: ['first', 'second'].map((value) => ({ value, name: value })),
    };
    const f = fixture({
      launchSettings: { reasoningEffort: 'high', applied: true },
      acpConfigSnapshot: {
        provider: 'CODEX',
        providerSessionId: 'thread',
        configOptions: [model, ...saved('high')],
      },
    });
    f.runtime.getClient.mockReturnValue(undefined);
    await f.service.setSessionModel('session', 'second');
    f.handle.configOptions = [
      { ...model, currentValue: 'second' },
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        name: 'Reasoning',
        type: 'select',
        currentValue: 'low',
        options: [{ value: 'low', name: 'Low' }],
      },
    ];
    f.runtime.getClient.mockReturnValue(f.handle);
    await f.service.applyConfiguredReasoningEffort('session', f.handle, {
      session: f.session,
      persistSnapshot: false,
      emitUpdates: false,
    });
    expect(
      f.handle.configOptions.find((option) => option.id === 'reasoning_effort')?.currentValue
    ).toBe('low');
    expect(f.runtime.setConfigOption).not.toHaveBeenCalled();
  });
  it('rejects explicit effort when a model exposes an empty option list', async () => {
    const f = fixture({ launchSettings: { reasoningEffort: 'medium', applied: false } });
    f.handle.configOptions = f.handle.configOptions.map((option) =>
      option.type === 'select' ? { ...option, options: [] } : option
    );
    await expect(
      f.service.applyConfiguredReasoningEffort('session', f.handle, { session: f.session })
    ).rejects.toThrow('Unsupported reasoning');
  });
  it('fails if the provider does not confirm an explicit effort', async () => {
    const f = fixture({ launchSettings: { reasoningEffort: 'medium', applied: false } });
    f.runtime.setConfigOption.mockResolvedValue(f.handle.configOptions);
    await expect(
      f.service.applyConfiguredReasoningEffort('session', f.handle, { session: f.session })
    ).rejects.toThrow('not applied');
  });
});
