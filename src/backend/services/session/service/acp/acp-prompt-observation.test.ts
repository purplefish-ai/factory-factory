import { expect, it, vi } from 'vitest';
import { AcpPromptController } from './acp-prompt-controller';
import { createTestProcessHandle } from './acp-runtime-manager.test-helpers';

function harness() {
  const calls: string[] = [];
  const handle = createTestProcessHandle({
    connection: {
      prompt: vi.fn(() => {
        calls.push('provider');
        return Promise.resolve({ stopReason: 'end_turn' as const });
      }),
    },
  });
  const controller = new AcpPromptController({
    isCurrentHandle: () => true,
    stopClient: async () => undefined,
  });
  const observation = {
    assertCurrent: () => undefined,
    beforeSend: vi.fn(() => {
      calls.push('sending');
      return Promise.resolve();
    }),
    outcome: vi.fn(() => {
      calls.push('outcome');
      return Promise.resolve();
    }),
    ambiguous: vi.fn(() => {
      calls.push('ambiguous');
      return Promise.resolve();
    }),
  };
  const send = () =>
    controller.sendPrompt(
      'session',
      handle,
      [{ type: 'text', text: 'task' }],
      undefined,
      observation
    );
  return { calls, handle, controller, observation, send };
}
it('never invokes the provider when durable SENDING fails', async () => {
  const h = harness();
  h.observation.beforeSend.mockRejectedValue(new Error('database unavailable'));
  await expect(h.send()).rejects.toThrow('database unavailable');
  expect(h.calls).toEqual([]);
});
it('rechecks the attempt after the durable write and never sends stale work', async () => {
  const h = harness();
  h.observation.beforeSend.mockImplementation(() => {
    h.observation.assertCurrent = () => {
      throw new Error('rotated');
    };
    return Promise.resolve();
  });
  await expect(h.send()).rejects.toThrow('rotated');
  expect(h.calls).toEqual(['ambiguous']);
});
it('awaits durable terminal outcome before prompt completion', async () => {
  const h = harness();
  let release!: () => void;
  h.observation.outcome.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  let done = false;
  const pending = h.send().then(() => {
    done = true;
  });
  await vi.waitFor(() => expect(h.calls).toEqual(['sending', 'provider']));
  expect(done).toBe(false);
  release();
  await pending;
  expect(done).toBe(true);
});
it('retains ambiguity if persistence fails after a successful provider response', async () => {
  const h = harness();
  h.observation.outcome.mockRejectedValue(new Error('outcome write failed'));
  await expect(h.send()).rejects.toThrow('outcome write failed');
  expect(h.calls).toEqual(['sending', 'provider', 'ambiguous']);
});
it('records terminal provider failure as sanitized outcome before throwing', async () => {
  const h = harness();
  vi.mocked(h.handle.connection.prompt).mockResolvedValue({
    stopReason: 'end_turn',
    _meta: {
      jetbrains: {
        air: { sessionFailure: { severity: 'error', title: 'credential-bearing text' } },
      },
    },
  });
  await expect(h.send()).rejects.toThrow();
  expect(h.observation.outcome).toHaveBeenCalledWith({ stopReason: 'end_turn', result: 'FAILED' });
  expect(h.calls).toEqual(['sending', 'outcome']);
});
