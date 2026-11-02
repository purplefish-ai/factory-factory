import { expect, it, vi } from 'vitest';
import { PromptNotInvokedError } from '@/backend/services/session/service/acp/acp-prompt-invocation';
import {
  createManagerTestHarness,
  mockPrompt,
  setupSuccessfulSpawn,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-harness';
import {
  createDeferred,
  createTestProcessHandle,
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

it('keeps late pending edits behind a frozen prompt configuration boundary without deadlocking native readiness', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const handle = await manager.getOrCreateClient(
    'session',
    defaultOptions(),
    defaultHandlers(),
    defaultContext()
  );
  const queue = new SessionConfigMutationQueue(manager, vi.fn());
  const claiming = createDeferred<void>();
  const response = createDeferred<{ stopReason: 'end_turn' }>();
  let model = 'original';
  let frozen: string | undefined;
  const observed: string[] = [];
  vi.mocked(handle.connection.prompt).mockImplementation(() => {
    observed.push(model);
    return response.promise;
  });
  const priorEdit = queue.run('session', () => {
    model = 'accepted-before-freeze';
    return Promise.resolve();
  });
  const prompt = queue.runPrompt('session', async (permit) => {
    frozen = model;
    await claiming.promise;
    return manager.sendPrompt('session', [], undefined, undefined, undefined, permit);
  });
  await priorEdit;
  await vi.waitFor(() => expect(frozen).toBe('accepted-before-freeze'));
  const laterEdit = queue.run('session', () => {
    model = 'accepted-after-turn';
    return Promise.resolve();
  });
  expect(handle.pendingConfigUpdates).toBeDefined();
  claiming.resolve();
  await vi.waitFor(() => expect(observed).toEqual([frozen]));
  expect(model).toBe(frozen);
  response.resolve({ stopReason: 'end_turn' });
  await Promise.all([prompt, laterEdit]);
  expect(model).toBe('accepted-after-turn');
});

it('rejects deferred edits and admits a replacement runtime when an old prompt never settles after stop', async () => {
  const first = createTestProcessHandle();
  const replacement = createTestProcessHandle({ providerSessionId: 'replacement' });
  const runtime = { getClient: vi.fn(() => first), isStopInProgress: () => false };
  const queue = new SessionConfigMutationQueue(runtime, vi.fn());
  const entered = createDeferred<void>();
  const pending = createDeferred<void>();
  const prompt = queue
    .runPrompt('session', async () => {
      entered.resolve();
      await pending.promise;
    })
    .catch(() => undefined);
  await entered.promise;
  let rejected: unknown;
  const edit = queue
    .run('session', () => Promise.resolve())
    .catch((error: unknown) => {
      rejected = error;
    });
  const stopped = new Error('runtime stopped');
  first.failConfiguration(stopped);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(rejected).toBe(stopped);
    runtime.getClient.mockReturnValue(replacement);
    expect(await queue.runPrompt('session', () => Promise.resolve('replacement admitted'))).toBe(
      'replacement admitted'
    );
  } finally {
    pending.resolve();
    await Promise.allSettled([prompt, edit]);
  }
});

it('retains the durable provider identity when native Codex IDs are normalized', async () => {
  const handle = createTestProcessHandle({ provider: 'CODEX', providerSessionId: 'sess_native' });
  const queue = new SessionConfigMutationQueue(
    { getClient: () => handle, isStopInProgress: () => false },
    vi.fn()
  );
  expect(handle.acpSessionId).toBe('native');
  await queue.runPrompt('session', (permit) => {
    expect(permit.providerSessionId).toBe('sess_native');
    return Promise.resolve();
  });
});

it('provides explicit non-invocation proof when an admitted native prompt is locally fenced before RPC', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const handle = await manager.getOrCreateClient(
    'session',
    defaultOptions(),
    defaultHandlers(),
    defaultContext()
  );
  const queue = new SessionConfigMutationQueue(manager, vi.fn());
  await expect(
    queue.runPrompt('session', (permit) =>
      manager.sendPrompt(
        'session',
        [],
        undefined,
        undefined,
        {
          check: () => Promise.reject(new Error('fenced before RPC')),
        },
        permit
      )
    )
  ).rejects.toBeInstanceOf(PromptNotInvokedError);
  expect(handle.connection.prompt).not.toHaveBeenCalled();
});

it('never reports non-invocation proof after entering a failing provider RPC', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const handle = await manager.getOrCreateClient(
    'session',
    defaultOptions(),
    defaultHandlers(),
    defaultContext()
  );
  const failure = new Error('provider result lost');
  vi.mocked(handle.connection.prompt).mockRejectedValueOnce(failure);
  const queue = new SessionConfigMutationQueue(manager, vi.fn());
  await expect(
    queue.runPrompt('session', (permit) =>
      manager.sendPrompt('session', [], undefined, undefined, undefined, permit)
    )
  ).rejects.toBe(failure);
  expect(handle.connection.prompt).toHaveBeenCalledOnce();
});
