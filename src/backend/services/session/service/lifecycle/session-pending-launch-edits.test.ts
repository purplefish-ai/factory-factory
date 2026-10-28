import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { readSessionLaunchSettings } from './session-launch-settings';
import { createLifecycleTestSession } from './session-lifecycle.test-helpers';
import { SessionConfigService } from './session.config.service';

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
  const service = new SessionConfigService({
    repository: unsafeCoerce(repository),
    runtimeManager: unsafeCoerce(runtime),
    codexModelCatalogService: { getModels: vi.fn() },
    sessionDomainService: unsafeCoerce({ emitDelta: vi.fn() }),
  });
  return { mode, off, session, handle, runtime, service };
}
describe('explicit stopped edits during a pending launch', () => {
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
