// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest';
import { waitForHighlighting } from './wait-for-highlighting.mjs';

afterEach(() => {
  vi.useRealTimers();
});

it('rejects with a clear deadline when highlighting never appears', async () => {
  vi.useFakeTimers();
  const node = document.createElement('div');
  const result = waitForHighlighting(node, 32).then(
    () => 'highlighted',
    (error: Error) => error.message
  );
  await vi.advanceTimersByTimeAsync(64);
  expect(await Promise.race([result, Promise.resolve('still pending')])).toBe(
    'Timed out waiting for syntax highlighting after 32 ms'
  );
});

it('finishes when the deferred highlighter adds a keyword before the deadline', async () => {
  vi.useFakeTimers();
  const node = document.createElement('div');
  const result = waitForHighlighting(node, 64);
  setTimeout(() => {
    node.innerHTML = '<span class="token keyword">const</span>';
  }, 16);
  await vi.advanceTimersByTimeAsync(32);
  await expect(result).resolves.toBeUndefined();
});
