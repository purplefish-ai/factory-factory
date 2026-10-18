import { expect, it, vi } from 'vitest';
import { waitForHighlightingPreview } from './wait-for-highlighting.mjs';

it('reports the stalled preview language, theme, and readiness state at its deadline', async () => {
  const stalled = {
    index: 7,
    language: 'language-tsx',
    theme: 'dark',
    settled: false,
    visible: true,
    colored: false,
    ready: false,
  };
  const page = {
    evaluate: vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 16 }, (_, index) => (index === 7 ? stalled : { index, ready: true }))
      ),
  };
  await expect(waitForHighlightingPreview(page, 16)).rejects.toThrow(
    '"language":"language-tsx","theme":"dark","settled":false'
  );
});

it('returns the same successful sample state used for readiness', async () => {
  const samples = Array.from({ length: 16 }, (_, index) => ({ index, ready: true }));
  const page = { evaluate: vi.fn().mockResolvedValue(samples) };
  expect(await waitForHighlightingPreview(page, 16)).toBe(samples);
  expect(page.evaluate).toHaveBeenCalledTimes(1);
});
