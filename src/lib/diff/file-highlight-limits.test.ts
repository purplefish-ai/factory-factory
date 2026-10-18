import { expect, it } from 'vitest';
import { isFileBlockWithinByteBudget } from './file-highlight-limits';

it('counts UTF-8 bytes rather than treating multibyte text as ASCII', () => {
  expect(isFileBlockWithinByteBudget('界'.repeat(10_000))).toBe(true);
  expect(isFileBlockWithinByteBudget('界'.repeat(12_000))).toBe(false);
  expect(isFileBlockWithinByteBudget('😀'.repeat(8000))).toBe(true);
  expect(isFileBlockWithinByteBudget('😀'.repeat(9000))).toBe(false);
});
