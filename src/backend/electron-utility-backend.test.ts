import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  type ElectronUtilityBackendDependencies,
  runElectronUtilityBackend,
  type UtilityBackendMessage,
} from './electron-utility-backend';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides: Partial<ElectronUtilityBackendDependencies> = {}) {
  const port = new EventEmitter();
  const posted: UtilityBackendMessage[] = [];
  const parentPort = {
    on: (event: 'message', listener: (event: { data: unknown }) => void) =>
      port.on(event, listener),
    postMessage: (message: UtilityBackendMessage) => posted.push(message),
  };
  const exit = vi.fn();
  const processEvents = Object.assign(new EventEmitter(), { exit });
  const fakeProcess = processEvents;
  const server = {
    start: vi.fn().mockResolvedValue('http://localhost:3001'),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const deps: ElectronUtilityBackendDependencies = {
    parentPort,
    process: fakeProcess,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    migrate: vi.fn(),
    createServer: vi.fn().mockResolvedValue(server),
    ...overrides,
  };
  const send = (data: unknown) => port.emit('message', { data });
  return { deps, exit, posted, processEvents, send, server };
}

describe('runElectronUtilityBackend', () => {
  it('runs migrations before composing the server and reports the URL', async () => {
    const order: string[] = [];
    const harness = createHarness();
    vi.mocked(harness.deps.migrate).mockImplementation(() => {
      order.push('migrate');
    });
    harness.server.start.mockImplementation(() => {
      order.push('start');
      return Promise.resolve('http://localhost:4100');
    });
    vi.mocked(harness.deps.createServer).mockImplementation(() => {
      order.push('createServer');
      return Promise.resolve(harness.server);
    });

    await runElectronUtilityBackend(harness.deps);

    expect(order).toEqual(['migrate', 'createServer', 'start']);
    expect(harness.posted).toEqual([{ type: 'ready', url: 'http://localhost:4100' }]);
    expect(harness.exit).not.toHaveBeenCalled();
  });

  it('reports migration failures and exits without creating a server', async () => {
    const harness = createHarness({
      migrate: vi.fn(() => {
        throw new Error('bad migration');
      }),
    });

    await runElectronUtilityBackend(harness.deps);

    expect(harness.deps.createServer).not.toHaveBeenCalled();
    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0]).toMatchObject({ type: 'error' });
    expect(harness.posted[0]?.type === 'error' && harness.posted[0].message).toContain(
      'bad migration'
    );
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it('reports startup failures and exits', async () => {
    const harness = createHarness();
    harness.server.start.mockRejectedValue(new Error('port in use'));

    await runElectronUtilityBackend(harness.deps);

    expect(harness.posted[0]).toMatchObject({ type: 'error' });
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it('stops the server and exits cleanly on a shutdown message', async () => {
    const harness = createHarness();
    await runElectronUtilityBackend(harness.deps);

    harness.send({ type: 'shutdown' });
    harness.send({ type: 'shutdown' });
    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(0));

    expect(harness.server.stop).toHaveBeenCalledTimes(1);
  });

  it('exits with a failure code when graceful shutdown fails', async () => {
    const harness = createHarness();
    harness.server.stop.mockRejectedValue(new Error('cleanup failed'));
    await runElectronUtilityBackend(harness.deps);

    harness.send({ type: 'shutdown' });

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(1));
  });

  it('ignores unknown messages', async () => {
    const harness = createHarness();
    await runElectronUtilityBackend(harness.deps);

    harness.send({ type: 'restart' });
    harness.send('shutdown');

    expect(harness.server.stop).not.toHaveBeenCalled();
    expect(harness.deps.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('lets a shutdown during startup exit cleanly instead of reporting an error', async () => {
    const started = deferred<string>();
    const harness = createHarness();
    harness.server.start.mockReturnValue(started.promise);
    const run = runElectronUtilityBackend(harness.deps);
    await vi.waitFor(() => expect(harness.server.start).toHaveBeenCalled());

    harness.send({ type: 'shutdown' });
    started.reject(new Error('Server has already been stopped'));
    await run;

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(0));
    expect(harness.posted).toEqual([]);
    expect(harness.exit).not.toHaveBeenCalledWith(1);
  });

  it('stops the server on SIGTERM', async () => {
    const harness = createHarness();
    await runElectronUtilityBackend(harness.deps);

    harness.processEvents.emit('SIGTERM');

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(0));
    expect(harness.server.stop).toHaveBeenCalled();
  });

  it('stops the server and exits with failure on an uncaught exception', async () => {
    const harness = createHarness();
    await runElectronUtilityBackend(harness.deps);

    harness.processEvents.emit('uncaughtException', new Error('boom'));

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(1));
    expect(harness.server.stop).toHaveBeenCalled();
  });

  it('exits on a fatal error before the server exists', async () => {
    const created = deferred<never>();
    const harness = createHarness({ createServer: vi.fn(() => created.promise) });
    void runElectronUtilityBackend(harness.deps);

    harness.processEvents.emit('unhandledRejection', new Error('early'));

    await vi.waitFor(() => expect(harness.exit).toHaveBeenCalledWith(1));
    expect(harness.server.stop).not.toHaveBeenCalled();
  });
});
