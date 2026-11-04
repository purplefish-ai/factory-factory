import { expect, it, vi } from 'vitest';
import type { AgentSessionRecord } from '@/backend/services/session/resources/agent-session.accessor';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createSessionLaunchMetadata } from './session-launch-settings';
import { applyStartupLaunchAccess } from './session-startup-access';

function fixture(values: string[], provider: 'CLAUDE' | 'CODEX' = 'CLAUDE') {
  const handle = createTestProcessHandle({ provider });
  handle.configOptions = [
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: 'default',
      options: values.map((value) => ({ value, name: value })),
    },
  ];
  const session = unsafeCoerce<AgentSessionRecord>({
    provider,
    workflow: 'event-agent',
    providerMetadata: createSessionLaunchMetadata({ accessMode: 'auto', planModeEnabled: false }),
  });
  const runtime = {
    setSessionMode: vi.fn((_id: string, value: string) => {
      handle.configOptions = handle.configOptions.map((option) =>
        option.type === 'select' ? { ...option, currentValue: value } : option
      );
      return Promise.resolve(handle.configOptions);
    }),
  };
  return { handle, session, runtime };
}

it.each([
  { values: ['default', 'acceptEdits'], expected: 'acceptEdits' },
  { values: ['default', 'auto', 'acceptEdits'], expected: 'auto' },
])(
  'applies and confirms frozen Claude RELAXED intent as $expected',
  async ({ values, expected }) => {
    const f = fixture(values);
    const confirmation = { assertCurrent: vi.fn(), confirmTarget: vi.fn() };
    await applyStartupLaunchAccess('session', f.session, f.handle, f.runtime, false, confirmation);
    expect(f.runtime.setSessionMode).toHaveBeenCalledWith('session', expected);
    expect(confirmation.confirmTarget).toHaveBeenCalledWith('mode', expected);
    expect(f.session.providerMetadata).toEqual(
      createSessionLaunchMetadata({ accessMode: 'auto', planModeEnabled: false })
    );
  }
);

it.each(['CLAUDE', 'CODEX'] as const)(
  'rejects unavailable %s access without granting bypass permissions',
  async (provider) => {
    const f = fixture(
      ['default', 'bypassPermissions', ...(provider === 'CODEX' ? ['acceptEdits'] : [])],
      provider
    );
    await expect(
      applyStartupLaunchAccess('session', f.session, f.handle, f.runtime, false)
    ).rejects.toThrow('Requested access mode is unavailable');
    expect(f.runtime.setSessionMode).not.toHaveBeenCalled();
  }
);
