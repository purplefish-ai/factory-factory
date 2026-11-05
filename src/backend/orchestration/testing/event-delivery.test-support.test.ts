import { expect, it } from 'vitest';
import {
  deferred,
  waitForEventFixture,
  trackEventFixtureTask,
  drainEventFixtureTasks,
} from './event-delivery.test-support';

it('returns readiness without waiting for the launch to finish', async () => {
  const launch = deferred<void>();
  await expect(
    waitForEventFixture(Promise.resolve('ready'), 'provider', { settled: launch.promise })
  ).resolves.toBe('ready');
});

it('surfaces startup rejection before readiness', async () => {
  const ready = deferred<void>();
  const failure = new Error('Provider startup failed');
  await expect(
    waitForEventFixture(ready.promise, 'provider', { settled: Promise.reject(failure) })
  ).rejects.toBe(failure);
});

it('rejects a launch that finishes without producing the expected event', async () => {
  const ready = deferred<void>();
  await expect(
    waitForEventFixture(ready.promise, 'provider', { settled: Promise.resolve() })
  ).rejects.toThrow('Launch settled before provider');
});

it('bounds a missing event when no launch settlement is provided', async () => {
  const ready = deferred<void>();
  await expect(waitForEventFixture(ready.promise, 'provider', { timeoutMs: 10 })).rejects.toThrow(
    'Timed out waiting for provider'
  );
});

it('keeps fixture teardown waiting for work spawned by a settling background operation', async () => {
  const parent = deferred<void>();
  const child = deferred<void>();
  let drained = false;
  const parentTask = trackEventFixtureTask(
    parent.promise.then(() => {
      void trackEventFixtureTask(child.promise);
    })
  );
  const teardown = drainEventFixtureTasks().then(() => {
    drained = true;
  });
  try {
    parent.resolve();
    await parentTask;
    // Observe the next event-loop turn while the real child boundary remains held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
  } finally {
    child.resolve();
    await teardown;
    await drainEventFixtureTasks();
  }
  expect(drained).toBe(true);
});
