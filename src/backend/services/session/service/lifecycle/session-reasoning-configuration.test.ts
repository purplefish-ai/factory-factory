import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { applyReasoningEffortTarget } from './session-reasoning-configuration';
it('re-persists a repeated confirmed effort after the earlier best-effort snapshot write failed', async () => {
  const handle = createTestProcessHandle({ provider: 'CODEX' });
  handle.configOptions = [
    {
      id: 'reasoning_effort',
      name: 'Thinking',
      type: 'select',
      currentValue: 'low',
      options: ['low', 'medium'].map((value) => ({ value, name: value })),
    },
  ];
  const confirmed: SessionConfigOption[] = handle.configOptions.map((option) =>
    option.type === 'select' ? { ...option, currentValue: 'medium' } : option
  );
  let saved: SessionConfigOption[] = handle.configOptions;
  const deps = {
    runtimeManager: { setConfigOption: vi.fn().mockResolvedValue(confirmed) },
    persistSnapshot: vi
      .fn((_id: string, params: { configOptions: SessionConfigOption[] }) => {
        saved = params.configOptions;
        return Promise.resolve();
      })
      .mockResolvedValueOnce(undefined),
    emitDelta: vi.fn(),
  };
  const params = {
    sessionId: 'session',
    handle,
    targetReasoningEffort: 'medium',
    source: 'message' as const,
  };
  await applyReasoningEffortTarget(params, deps);
  expect(saved[0]?.currentValue).toBe('low');
  await applyReasoningEffortTarget(params, deps);
  expect(deps.runtimeManager.setConfigOption).toHaveBeenCalledTimes(1);
  expect(deps.persistSnapshot).toHaveBeenCalledTimes(2);
  expect(saved[0]?.currentValue).toBe('medium');
});
