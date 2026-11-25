import { expect, it } from 'vitest';
import { formatArchiveIncompleteMessage, hasArchiveIncompleteMarker } from './archive-incomplete';

it('formats a marked message that the marker check recognises', () => {
  const message = formatArchiveIncompleteMessage('git worktree remove timed out.');

  expect(message).toBe(
    'Archive incomplete: git worktree remove timed out. Archive again to finish.'
  );
  expect(hasArchiveIncompleteMarker(message)).toBe(true);
  expect(hasArchiveIncompleteMarker('Setup script failed')).toBe(false);
  expect(hasArchiveIncompleteMarker(null)).toBe(false);
});

it('bounds a long reason without splitting a surrogate pair', () => {
  const message = formatArchiveIncompleteMessage(`${'a'.repeat(499)}😀😀`);

  expect(message).toBe(`Archive incomplete: ${'a'.repeat(499)}😀…. Archive again to finish.`);
  expect(message.isWellFormed()).toBe(true);
});
