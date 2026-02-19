import { describe, expect, it } from 'vitest';
import { buildCombinedEntries, getPartialDataWarning } from './combined-changes-panel';

describe('buildCombinedEntries', () => {
  it('does not mark main-relative files as not pushed when upstream is in sync', () => {
    const entries = buildCombinedEntries(
      [],
      [{ path: 'src/example.ts', status: 'modified' }],
      new Set<string>()
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.showIndicatorDot).toBe(false);
  });

  it('marks files changed by unpushed commits', () => {
    const entries = buildCombinedEntries(
      [],
      [{ path: 'src/example.ts', status: 'modified' }],
      new Set(['src/example.ts'])
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.showIndicatorDot).toBe(true);
  });

  it('always marks staged files', () => {
    const entries = buildCombinedEntries(
      [{ path: 'src/example.ts', status: 'M', staged: true }],
      [],
      new Set<string>()
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.showIndicatorDot).toBe(true);
  });
});

describe('getPartialDataWarning', () => {
  it('returns a combined warning when git status and unpushed detection fail', () => {
    const warning = getPartialDataWarning({
      gitError: new Error('git failed'),
      diffError: undefined,
      unpushedError: new Error('unpushed failed'),
    });

    expect(warning).toBe(
      'Git status and not-pushed detection unavailable; showing diff vs main only.'
    );
  });

  it('returns a combined warning when diff and unpushed detection fail', () => {
    const warning = getPartialDataWarning({
      gitError: undefined,
      diffError: new Error('diff failed'),
      unpushedError: new Error('unpushed failed'),
    });

    expect(warning).toBe(
      'Diff vs main and not-pushed detection unavailable; showing working tree changes only.'
    );
  });
});
