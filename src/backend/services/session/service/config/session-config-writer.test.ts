import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { expect, it, vi } from 'vitest';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { SessionDeltaEventSchema } from '@/shared/acp-protocol/protocol/chat-server-message-schema';
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

it('publishes configuration and capability deltas the chat client accepts', async () => {
  const handle = createTestProcessHandle({ provider: 'CLAUDE' });
  handle.configOptions = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'opus',
      options: [{ group: 'Claude', name: 'Claude', options: [{ value: 'opus', name: 'Opus' }] }],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: ['default', 'plan'].map((value) => ({ value, name: value, description: null })),
    },
  ];
  const emitDelta = vi.fn();
  const writer = new SessionConfigWriter(
    unsafeCoerce({ getClient: () => handle, isStopInProgress: () => false }),
    unsafeCoerce({}),
    unsafeCoerce({ emitDelta })
  );
  vi.spyOn(writer.snapshots, 'persist').mockResolvedValue(undefined);

  await writer.persistAndEmit('session', handle);

  const deltas = emitDelta.mock.calls.map(([, delta]) => JSON.parse(JSON.stringify(delta)));
  expect(deltas.map((delta) => delta.type)).toEqual(['config_options_update', 'chat_capabilities']);
  // The wire schema drops the ACP group `name`, which the client never reads.
  for (const delta of deltas) {
    expect(SessionDeltaEventSchema.safeParse(delta)).toMatchObject({ success: true });
  }
});
