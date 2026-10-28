import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  createSessionLaunchMetadata,
  markSessionLaunchSettingsApplied,
  readSessionLaunchSettings,
} from './session-launch-settings';
import { applyStartupLaunchPlan } from './session-startup-plan';
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
  it('turns Claude Plan off into configured STRICT access rather than legacy bypass', async () => {
    const f = fixture('CLAUDE', false);
    await applyStartupLaunchPlan('session', f.session, f.handle, 'STRICT', f.runtime);
    expect(f.runtime.setSessionMode).toHaveBeenCalledWith('session', 'default');
    expect(f.handle.configOptions[0]?.currentValue).toBe('default');
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
