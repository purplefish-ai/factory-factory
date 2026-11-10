import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigWriter } from './session-config-writer';
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
  const runtimeManager = {
    getClient: () => handle,
    isStopInProgress: () => false,
    setConfigOption: vi.fn(() => {
      handle.configOptions = confirmed;
      return Promise.resolve(confirmed);
    }),
  };
  const writer = new SessionConfigWriter(
    unsafeCoerce(runtimeManager),
    unsafeCoerce({}),
    unsafeCoerce({ emitDelta: vi.fn() })
  );
  // The first snapshot write is best-effort and does not land.
  const persistSnapshot = vi
    .spyOn(writer.snapshots, 'persist')
    .mockImplementation((_id: string, params: { configOptions: SessionConfigOption[] }) => {
      saved = params.configOptions;
      return Promise.resolve();
    })
    .mockResolvedValueOnce(undefined);
  const params = {
    sessionId: 'session',
    handle,
    targetReasoningEffort: 'medium',
    source: 'message' as const,
  };
  await writer.applyReasoningEffortTarget(params);
  expect(saved[0]?.currentValue).toBe('low');
  await writer.applyReasoningEffortTarget(params);
  expect(runtimeManager.setConfigOption).toHaveBeenCalledTimes(1);
  expect(persistSnapshot).toHaveBeenCalledTimes(2);
  expect(saved[0]?.currentValue).toBe('medium');
});
