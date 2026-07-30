import { describe, expect, it } from 'vitest';
import { buildChangeTree, type ChangeListEntry } from './change-panel-shared';
import {
  buildCombinedEntries,
  getIndicatorLabel,
  getPartialDataWarning,
} from './combined-changes-panel';

const gitDirectoryEntry: ChangeListEntry = {
  path: 'myfolder/',
  kind: 'untracked',
  statusCode: '?',
};
const childFileEntry: ChangeListEntry = {
  path: 'myfolder/a.ts',
  kind: 'modified',
  statusCode: 'M',
};

describe('buildChangeTree', () => {
  it.each([
    ['before', [gitDirectoryEntry, childFileEntry]],
    ['after', [childFileEntry, gitDirectoryEntry]],
  ])('unifies a git-reported directory with its child when the directory appears %s the child', (_order, entries) => {
    expect(buildChangeTree(entries)).toEqual([
      {
        name: 'myfolder',
        path: 'myfolder',
        type: 'directory',
        entry: gitDirectoryEntry,
        children: [
          {
            name: 'a.ts',
            path: 'myfolder/a.ts',
            type: 'file',
            entry: childFileEntry,
            children: [],
          },
        ],
      },
    ]);
  });

  it('unifies a nested git-reported directory with its child file', () => {
    const nestedDirectoryEntry: ChangeListEntry = {
      path: 'outer/inner/',
      kind: 'untracked',
      statusCode: '?',
    };
    const nestedFileEntry: ChangeListEntry = {
      path: 'outer/inner/a.ts',
      kind: 'modified',
      statusCode: 'M',
    };

    expect(buildChangeTree([nestedDirectoryEntry, nestedFileEntry])).toEqual([
      {
        name: 'outer',
        path: 'outer',
        type: 'directory',
        children: [
          {
            name: 'inner',
            path: 'outer/inner',
            type: 'directory',
            entry: nestedDirectoryEntry,
            children: [
              {
                name: 'a.ts',
                path: 'outer/inner/a.ts',
                type: 'file',
                entry: nestedFileEntry,
                children: [],
              },
            ],
          },
        ],
      },
    ]);
  });
});

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

describe('getIndicatorLabel', () => {
  it('returns staged-only label when no upstream is configured', () => {
    expect(getIndicatorLabel(false)).toBe('Staged');
  });

  it('returns staged-or-unpushed label when upstream is configured', () => {
    expect(getIndicatorLabel(true)).toBe('Staged or not pushed to remote');
  });
});
