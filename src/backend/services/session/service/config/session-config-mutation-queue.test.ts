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
  const handle = await manager.getOrCreateClient(
    'session',
    defaultOptions(),
    defaultHandlers(),
    defaultContext()
  );
  void manager.sendPrompt('session', []);
  let applied = false;
  const queue = new SessionConfigMutationQueue(manager, vi.fn());
  const edit = queue
    .run('session', () => {
      applied = true;
      return Promise.resolve();
    })
    .catch((error: unknown) => error);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(applied).toBe(false);
  const exited = new Error('ACP process exited: session');
  const rejectConfiguration = vi.spyOn(handle, 'failConfiguration');
  child.exitCode = 1;
  child.emit('exit', 1, null);
  expect(rejectConfiguration).toHaveBeenCalledWith(exited);
  expect(await edit).toBe(rejectConfiguration.mock.calls[0]?.[0]);
  expect(applied).toBe(false);
});

it('rejects fenced configuration before invoking a provider mutation', async () => {
  const operation = vi.fn(async () => undefined);
  const queue = new SessionConfigMutationQueue(
    { getClient: () => undefined, isStopInProgress: () => false },
    () => undefined,
    () => Promise.reject(new Error('initial fenced'))
  );
  await expect(queue.run('session', operation)).rejects.toThrow('initial fenced');
  expect(operation).not.toHaveBeenCalled();
});
it.each([false, true])(
  'publishes correction for a fence after prompt wait=%s without mutation',
  async (wait) => {
    const { manager } = createManagerTestHarness();
    setupSuccessfulSpawn();
    const handle = await manager.getOrCreateClient(
      'session',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    let fenced = !wait;
    handle.isPromptInFlight = wait;
    const allowed = vi.fn(() => (fenced ? Promise.reject(new Error('fenced')) : Promise.resolve()));
    const correction = vi.fn();
    const operation = vi.fn(async () => undefined);
    const queue = new SessionConfigMutationQueue(manager, correction, allowed);
    const pending = expect(queue.run('session', operation)).rejects.toThrow('fenced');
    await vi.waitFor(() => expect(allowed).toHaveBeenCalledOnce());
    fenced = true;
    handle.isPromptInFlight = false;
    await pending;
    expect(allowed).toHaveBeenCalledTimes(wait ? 2 : 1);
    expect(operation).not.toHaveBeenCalled();
    expect(correction).toHaveBeenCalledWith('session', handle.configOptions);
  }
);
