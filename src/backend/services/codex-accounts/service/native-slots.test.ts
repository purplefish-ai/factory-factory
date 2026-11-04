import { expect, it, vi } from 'vitest';
import { acquireNativeSlot } from './native-slots';
it('caps simultaneous native probes and removes cancelled queued requests', async () => {
  const release = await Promise.all(Array.from({ length: 4 }, () => acquireNativeSlot(1000)));
  const cancel = new AbortController();
  const pending = acquireNativeSlot(1000, cancel.signal);
  const rejected = expect(pending).rejects.toThrow('cancelled');
  cancel.abort();
  await rejected;
  let admitted = false;
  const next = acquireNativeSlot(1000).then((done) => {
    admitted = true;
    return done;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  release[0]?.();
  const done = await next;
  expect(admitted).toBe(true);
  done();
  for (const finish of release) {
    finish();
  }
});

it('gives retry guidance when waiting for a native process slot times out', async () => {
  vi.useFakeTimers();
  const release = await Promise.all(Array.from({ length: 4 }, () => acquireNativeSlot(1000)));
  try {
    const pending = acquireNativeSlot(1000);
    const rejected = expect(pending).rejects.toThrow(
      'Codex provider is unavailable. Please try again in a few moments.'
    );
    await Promise.all([vi.advanceTimersByTimeAsync(1000), rejected]);
  } finally {
    for (const finish of release) {
      finish();
    }
    vi.useRealTimers();
  }
});
