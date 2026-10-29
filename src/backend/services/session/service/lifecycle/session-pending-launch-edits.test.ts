import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { readSessionLaunchSettings } from './session-launch-settings';
import { createLifecycleTestSession } from './session-lifecycle.test-helpers';
import { SessionConfigService } from './session.config.service';
import { SessionRepository } from './session.repository';

function select(
  id: string,
  category: string,
  currentValue: string,
  values: string[]
): SessionConfigOption {
  return {
    id,
    category,
    name: id,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}
function fixture(provider: 'CLAUDE' | 'CODEX', applied = false) {
  const mode = provider === 'CLAUDE' ? 'mode' : 'collaboration_mode';
  const off = provider === 'CLAUDE' ? 'acceptEdits' : 'default';
  const configOptions = [
    select('effort', 'thought_level', 'high', ['low', 'high']),
    select('mode', 'mode', provider === 'CLAUDE' ? 'plan' : 'workspace-write', [
      'default',
      'plan',
      'acceptEdits',
      'workspace-write',
    ]),
    ...(provider === 'CODEX' ? [select(mode, mode, 'plan', ['default', 'plan'])] : []),
  ];
  const session = createLifecycleTestSession({
    provider,
    providerSessionId: 'thread',
    providerMetadata: unsafeCoerce({
      launchSettings: { reasoningEffort: 'high', planModeEnabled: true, applied },
      acpConfigSnapshot: { provider, providerSessionId: 'thread', configOptions },
    }),
  });
  const handle = createTestProcessHandle({ provider, providerSessionId: 'thread' });
  handle.configOptions = structuredClone(configOptions);
  const runtime = {
    isStopInProgress: () => false,
    getClient: vi.fn<() => typeof handle | undefined>(() => undefined),
    setConfigOption: vi.fn((_sid: string, id: string, value: string) => {
      handle.configOptions = handle.configOptions.map((option) =>
        option.type === 'select' && option.id === id ? { ...option, currentValue: value } : option
      );
      return Promise.resolve(handle.configOptions);
    }),
    setSessionMode: vi.fn((_sid: string, value: string) =>
      runtime.setConfigOption(_sid, 'mode', value)
    ),
  };
  const repository = {
    getSessionById: vi.fn().mockResolvedValue(session),
    updateSession: vi.fn((_sid: string, update: object) =>
      Promise.resolve(Object.assign(session, update))
    ),
  };
  const accessor = {
    findById: () => Promise.resolve(structuredClone(session)),
    update: repository.updateSession,
    updateIfProviderIdentity: (_id: string, expected: typeof session, data: object) => {
      if (
        expected.providerSessionId !== session.providerSessionId ||
        +expected.updatedAt !== +session.updatedAt ||
        JSON.stringify(expected.providerMetadata) !== JSON.stringify(session.providerMetadata)
      ) {
        return Promise.resolve(0);
      }
      Object.assign(session, data, { updatedAt: new Date(+session.updatedAt + 1) });
      return Promise.resolve(1);
    },
  };
  const durable = new SessionRepository(unsafeCoerce(accessor), unsafeCoerce({}));
  const service = new SessionConfigService({
    repository: durable,
    runtimeManager: unsafeCoerce(runtime),
    codexModelCatalogService: { getModels: vi.fn() },
    sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
  });
  return { mode, off, session, handle, runtime, service, accessor, durable };
}
describe('explicit stopped edits during a pending launch', () => {
  it('rejects a snapshot CAS after only provider identity changes', async () => {
    const f = fixture('CODEX');
    const original = f.accessor.updateIfProviderIdentity;
    const model = f.session.model;
    const metadata = structuredClone(f.session.providerMetadata);
    vi.spyOn(f.accessor, 'updateIfProviderIdentity').mockImplementationOnce((...args) => {
      f.session.providerSessionId = 'replacement';
      return original(...args);
    });
    await expect(
      f.durable.updateSession(f.session.id, {
        model: 'stale-write',
        providerMetadata: metadata,
      })
    ).rejects.toThrow('Stale provider metadata reconciliation');
    expect(f.session.providerSessionId).toBe('replacement');
    expect(f.session.model).toBe(model);
    expect(f.session.providerMetadata).toEqual(metadata);
  });

  it.each(['CLAUDE', 'CODEX'] as const)(
    'preserves latest %s effort and Plan edits through startup',
    async (provider) => {
      const f = fixture(provider);
      await f.service.setSessionConfigOption('session-1', 'effort', 'low');
      expect(readSessionLaunchSettings(f.session.providerMetadata)).toEqual({
        reasoningEffort: 'low',
        planModeEnabled: true,
        applied: false,
      });
      await f.service.setSessionConfigOption('session-1', f.mode, f.off);
      expect(readSessionLaunchSettings(f.session.providerMetadata)).toEqual({
        reasoningEffort: 'low',
        ...(provider === 'CLAUDE' ? { accessMode: 'acceptEdits' } : {}),
        planModeEnabled: false,
        applied: false,
      });
      f.runtime.getClient.mockReturnValue(f.handle);
      await f.service.applyConfiguredReasoningEffort('session-1', f.handle, {
        session: f.session,
        persistSnapshot: false,
        emitUpdates: false,
      });
      await f.service.applyConfiguredPermissionPreset('session-1', f.session, f.handle, 'STRICT');
      await f.service.applyStartupLaunchPlan('session-1', f.session, f.handle, 'STRICT');
      expect(f.handle.configOptions.find((option) => option.id === 'effort')?.currentValue).toBe(
        'low'
      );
      expect(f.handle.configOptions.find((option) => option.id === f.mode)?.currentValue).toBe(
        f.off
      );
      expect(readSessionLaunchSettings(f.session.providerMetadata)?.applied).toBe(false);
    }
  );
  it('keeps already consumed launch intent unchanged after later stopped edits', async () => {
    const f = fixture('CODEX', true);
    await f.service.setSessionConfigOption('session-1', 'effort', 'low');
    await f.service.setSessionConfigOption('session-1', f.mode, f.off);
    expect(readSessionLaunchSettings(f.session.providerMetadata)).toEqual({
      reasoningEffort: 'high',
      planModeEnabled: true,
      applied: true,
    });
  });
});
