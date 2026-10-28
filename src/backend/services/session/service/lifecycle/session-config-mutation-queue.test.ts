import { expect, it, vi } from 'vitest';
import {
  createManagerTestHarness,
  mockPrompt,
  setupSuccessfulSpawn,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-harness';
import {
  createDeferred,
  defaultContext,
  defaultHandlers,
  defaultOptions,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { SessionConfigMutationQueue } from './session-config-mutation-queue';

it.each(['resolve', 'reject'] as const)(
  'applies edits after a prompt %s and before the next prompt',
  async (outcome) => {
    const { manager } = createManagerTestHarness();
    setupSuccessfulSpawn();
    const active = createDeferred<{ stopReason: 'end_turn' }>();
    const writing = createDeferred<void>();
    let model = 'first';
    const observed: string[] = [];
    const handle = await manager.getOrCreateClient(
      'session',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    vi.mocked(handle.connection.prompt)
      .mockImplementationOnce(() => active.promise)
      .mockImplementationOnce(() => {
        observed.push(model);
        return Promise.resolve({ stopReason: 'end_turn' });
      });
    const current = manager.sendPrompt('session', []).catch(() => undefined);
    const queue = new SessionConfigMutationQueue(manager, vi.fn());
    const edit = queue.run('session', async () => {
      model = 'second';
      await writing.promise;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(model).toBe('first');
    const next = manager.sendPrompt('session', []);
    if (outcome === 'resolve') {
      active.resolve({ stopReason: 'end_turn' });
    } else {
      active.reject(new Error('turn failed'));
    }
    await current;
    await vi.waitFor(() => expect(model).toBe('second'));
    expect(observed).toEqual([]);
    writing.resolve();
    await Promise.all([edit, next]);
    expect(observed).toEqual(['second']);
  }
);

it('rejects deferred edits when the runtime exits without waiting for its prompt RPC', async () => {
  const { manager } = createManagerTestHarness();
  const child = setupSuccessfulSpawn();
  mockPrompt.mockReturnValueOnce(new Promise(() => undefined));
  await manager.getOrCreateClient('session', defaultOptions(), defaultHandlers(), defaultContext());
  void manager.sendPrompt('session', []);
  let applied = false;
  const queue = new SessionConfigMutationQueue(manager, vi.fn());
  const edit = queue
    .run('session', () => {
      applied = true;
      return Promise.resolve();
    })
    .catch((error: unknown) => error);
  child.exitCode = 1;
  child.emit('exit', 1, null);
  expect(await edit).toBeInstanceOf(Error);
  expect(applied).toBe(false);
});
