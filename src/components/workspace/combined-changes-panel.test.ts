import { describe, expect, it } from 'vitest';
import { buildCombinedEntries } from './combined-changes-panel';

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
