import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { resolveClosedSessionTranscriptPath } from './closed-session-storage';

it('accepts a legacy filename beginning with dots inside the worktree', () => {
  expect(
    resolveClosedSessionTranscriptPath({ transcriptPath: '..retained.json' }, '/worktree')
  ).toBe(resolve('/worktree', '..retained.json'));
});
it.each(['..', '../outside.json', '/outside.json', '.'])(
  'rejects a legacy path outside or equal to its worktree: %s',
  (transcriptPath) => {
    expect(() => resolveClosedSessionTranscriptPath({ transcriptPath }, '/worktree')).toThrow(
      'Invalid legacy transcript path'
    );
  }
);
