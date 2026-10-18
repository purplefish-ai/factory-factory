import { expect, it } from 'vitest';
import { isHighlightableFileBlock } from './file-highlight-limits';

it('counts UTF-8 bytes rather than treating multibyte text as ASCII', () => {
  expect(isHighlightableFileBlock('界'.repeat(10_000))).toBe(true);
  expect(isHighlightableFileBlock('界'.repeat(12_000))).toBe(false);
  expect(isHighlightableFileBlock('😀'.repeat(8000))).toBe(true);
  expect(isHighlightableFileBlock('😀'.repeat(9000))).toBe(false);
});
