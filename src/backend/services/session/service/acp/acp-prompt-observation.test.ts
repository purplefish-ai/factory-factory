const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logger }));
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
it('soft cancel during durable beforeSend prevents the later provider invocation', async () => {
  const h = harness();
  let release!: () => void;
  h.observation.beforeSend.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const pending = h.send();
  const rejected = expect(pending).rejects.toThrow('cancelled before send');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(await h.controller.cancelPrompt('session', h.handle)).toBe(true);
  release();
  await rejected;
  expect(h.handle.connection.prompt).not.toHaveBeenCalled();
  expect(h.observation.ambiguous).toHaveBeenCalledOnce();
  expect(h.handle.isPromptInFlight).toBe(false);
});

it('reports failed ambiguity persistence without leaking exceptions or replacing the prompt error', async () => {
  const h = harness();
  const original = new Error('provider credential-bearing payload');
  vi.mocked(h.handle.connection.prompt).mockRejectedValue(original);
  h.observation.ambiguous.mockRejectedValue(new Error('database secret'));
  await expect(h.send()).rejects.toBe(original);
  expect(logger.warn).toHaveBeenCalledWith('Initial delivery ambiguity persistence failed', {
    sessionId: 'session',
  });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('credential');
});
it('an older pending send cannot remove a newer cancellation token', async () => {
  const h = harness();
  let first!: () => void;
  let second!: () => void;
  h.observation.beforeSend
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          first = resolve;
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          second = resolve;
        })
    );
  const older = h.send();
  const newer = h.send();
  const newerResult = newer.catch((error: unknown) => error);
  first();
  await older;
  const cancelled = await h.controller.cancelPrompt('session', h.handle);
  second();
  expect(await newerResult).toBeInstanceOf(Error);
  expect(cancelled).toBe(true);
  expect(h.handle.connection.prompt).toHaveBeenCalledOnce();
});
