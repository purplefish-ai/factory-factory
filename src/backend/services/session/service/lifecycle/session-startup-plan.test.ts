import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import { AcpRuntimeConfigController } from '@/backend/services/session/service/acp/acp-runtime-config-controller';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { userSettingsService } from '@/backend/services/settings';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  createSessionLaunchMetadata,
  markSessionLaunchSettingsApplied,
  readSessionLaunchSettings,
} from './session-launch-settings';
import { applyStartupLaunchPlan } from './session-startup-plan';
import { SessionConfigService } from './session.config.service';
vi.mock('@/backend/services/settings', () => ({ userSettingsService: { get: vi.fn() } }));
function fixture(provider: 'CLAUDE' | 'CODEX', enabled: boolean) {
  const handle = createTestProcessHandle({ provider });
  const id = provider === 'CLAUDE' ? 'mode' : 'collaboration_mode';
  handle.configOptions = [
    {
      id,
      category: id,
      name: 'Mode',
      type: 'select',
      currentValue: enabled ? 'default' : 'plan',
      options: ['default', 'plan', 'bypassPermissions'].map((value) => ({ value, name: value })),
    },
  ];
  const session = unsafeCoerce<AgentSessionRecord>({
    provider,
    workflow: 'followup',
    providerMetadata: createSessionLaunchMetadata({ planModeEnabled: enabled }),
  });
  const apply = (_sid: string, value: string) => {
    handle.configOptions = handle.configOptions.map((option) =>
      option.type === 'select' ? { ...option, currentValue: value } : option
    );
    return Promise.resolve(handle.configOptions);
  };
  const runtime = {
    getClient: () => handle,
    isStopInProgress: () => false,
    setSessionMode: vi.fn(apply),
    setConfigOption: vi.fn((_sid: string, _id: string, value: string) => apply(_sid, value)),
  };
  return { handle, session, runtime };
}
describe('startup native planning', () => {
  it.each(['CLAUDE', 'CODEX'] as const)(
    'applies and confirms explicit %s Plan before readiness',
    async (provider) => {
      const f = fixture(provider, true);
      await applyStartupLaunchPlan('session', f.session, f.handle, 'STRICT', f.runtime);
      expect(f.handle.configOptions[0]?.currentValue).toBe('plan');
    }
  );
  it.each([
    { provider: 'CLAUDE' as const, enabled: true },
    { provider: 'CLAUDE' as const, enabled: false },
    { provider: 'CODEX' as const, enabled: true },
    { provider: 'CODEX' as const, enabled: false },
  ])('applies ID-only $provider Plan $enabled before readiness', async ({ provider, enabled }) => {
    const f = fixture(provider, enabled);
    f.handle.configOptions = f.handle.configOptions.map((option) => ({
      ...option,
      category: undefined,
    }));
    await applyStartupLaunchPlan('session', f.session, f.handle, 'STRICT', f.runtime);
    expect(f.handle.configOptions[0]?.currentValue).toBe(enabled ? 'plan' : 'default');
  });
  it.each([true, false])(
    'confirms ID-only Claude Plan %s through the actual runtime controller',
    async (enabled) => {
      const f = fixture('CLAUDE', enabled);
      f.handle.configOptions = f.handle.configOptions.map((option) => ({
        ...option,
        category: undefined,
      }));
      const nativeSetSessionMode = vi.fn().mockResolvedValue({});
      f.handle.connection.setSessionMode = nativeSetSessionMode;
      const controller = new AcpRuntimeConfigController();
      f.runtime.setSessionMode.mockImplementation((sessionId, modeId) =>
        controller.setSessionMode(f.handle, modeId, sessionId)
      );
      await applyStartupLaunchPlan('session', f.session, f.handle, 'STRICT', f.runtime);
      expect(f.handle.configOptions[0]?.currentValue).toBe(enabled ? 'plan' : 'default');
      expect(nativeSetSessionMode).toHaveBeenCalledWith({
        sessionId: f.handle.acpSessionId,
        modeId: enabled ? 'plan' : 'default',
      });
    }
  );
  it('turns Claude Plan off into configured STRICT access rather than legacy bypass', async () => {
    const f = fixture('CLAUDE', false);
    await applyStartupLaunchPlan('session', f.session, f.handle, 'STRICT', f.runtime);
    expect(f.runtime.setSessionMode).toHaveBeenCalledWith('session', 'default');
    expect(f.handle.configOptions[0]?.currentValue).toBe('default');
  });
  it.each([
    { autoSupported: true, expected: 'auto' },
    { autoSupported: false, expected: 'acceptEdits' },
  ])(
    'turns Claude Plan off into RELAXED Auto access (Auto supported: $autoSupported)',
    async ({ autoSupported, expected }) => {
      const f = fixture('CLAUDE', false);
      f.handle.configOptions = f.handle.configOptions.map((option) =>
        option.type === 'select'
          ? {
              ...option,
              options: ['default', 'plan', 'acceptEdits', 'auto'].map((value) => ({
                value,
                name: value,
              })),
            }
          : option
      );
      const apply = f.runtime.setSessionMode.getMockImplementation();
      // Claude's adapter applies Accept edits when the model lacks Auto mode.
      f.runtime.setSessionMode.mockImplementation((sid, value) =>
        apply!(sid, value === 'auto' && !autoSupported ? 'acceptEdits' : value)
      );
      const confirmTarget = vi.fn();
      await applyStartupLaunchPlan(
        'session',
        f.session,
        f.handle,
        'RELAXED',
        f.runtime,
        undefined,
        undefined,
        {
          assertCurrent: vi.fn(),
          confirmTarget,
        }
      );
      expect(f.runtime.setSessionMode).toHaveBeenCalledWith('session', 'auto');
      expect(f.handle.configOptions[0]?.currentValue).toBe(expected);
      expect(confirmTarget).toHaveBeenCalledWith('mode', expected);
    }
  );
  it('resolves configured Claude access when require-existing resume omits its permission preset', async () => {
    const f = fixture('CLAUDE', false);
    vi.mocked(userSettingsService.get).mockResolvedValueOnce(
      unsafeCoerce({ defaultWorkspacePermissions: 'STRICT' })
    );
    const service = new SessionConfigService({
      repository: unsafeCoerce({}),
      runtimeManager: unsafeCoerce(f.runtime),
      codexModelCatalogService: { getModels: vi.fn() },
      sessionDomainService: unsafeCoerce({}),
    });
    await service.applyStartupLaunchPlan('session', f.session, f.handle, undefined);
    expect(f.handle.configOptions[0]?.currentValue).toBe('default');
    expect(f.runtime.setSessionMode).toHaveBeenCalledWith('session', 'default');
  });
  it('propagates Plan rejection and rejects an unchanged native response', async () => {
    const f = fixture('CODEX', true);
    f.runtime.setConfigOption.mockRejectedValueOnce(new Error('Plan rejected'));
    await expect(
      applyStartupLaunchPlan('session', f.session, f.handle, 'STRICT', f.runtime)
    ).rejects.toThrow('Plan rejected');
    f.runtime.setConfigOption.mockResolvedValueOnce(f.handle.configOptions);
    await expect(
      applyStartupLaunchPlan('session', f.session, f.handle, 'STRICT', f.runtime)
    ).rejects.toThrow('not applied');
  });
  it('ignores consumed launch Plan intent after later native session changes', async () => {
    const f = fixture('CODEX', true);
    f.session.providerMetadata = unsafeCoerce(
      markSessionLaunchSettingsApplied(f.session.providerMetadata)
    );
    await applyStartupLaunchPlan('session', f.session, f.handle, 'STRICT', f.runtime);
    expect(f.runtime.setConfigOption).not.toHaveBeenCalled();
    expect(readSessionLaunchSettings(f.session.providerMetadata)?.applied).toBe(true);
  });
});
