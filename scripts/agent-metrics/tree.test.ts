import { describe, expect, it } from 'vitest';
import { guidanceSize, guideChains, isProductionSource, largeFiles, mostEditedFiles } from './tree';

describe('tree metrics', () => {
  it('builds the guide chain for each directory with an AGENTS.md', () => {
    const chains = guideChains([
      { path: 'src/backend/services/AGENTS.md', content: 'a\nb\n' },
      { path: 'AGENTS.md', content: '12345678\n' },
      { path: 'src/backend/AGENTS.md', content: 'c\n' },
      { path: 'src/client/AGENTS.md', content: 'd\n' },
    ]);
    expect(chains).toEqual([
      { directory: '.', guides: ['AGENTS.md'], lines: 1, tokens: 2 },
      {
        directory: 'src/backend',
        guides: ['AGENTS.md', 'src/backend/AGENTS.md'],
        lines: 2,
        tokens: 3,
      },
      {
        directory: 'src/backend/services',
        guides: ['AGENTS.md', 'src/backend/AGENTS.md', 'src/backend/services/AGENTS.md'],
        lines: 4,
        tokens: 4,
      },
      {
        directory: 'src/client',
        guides: ['AGENTS.md', 'src/client/AGENTS.md'],
        lines: 2,
        tokens: 3,
      },
    ]);
  });

  it('compares guidance lines with source lines', () => {
    expect(
      guidanceSize(
        [{ path: 'AGENTS.md', lines: 10 }],
        [{ path: 'docs/architecture/a.md', lines: 90 }],
        [
          { path: 'src/a.ts', lines: 1500 },
          { path: 'src/b.ts', lines: 500 },
        ]
      )
    ).toEqual({
      guideLines: 10,
      architectureNoteLines: 90,
      guidanceLines: 100,
      sourceLines: 2000,
      guidancePerThousandSourceLines: 50,
    });
  });

  it('ranks the most-edited files with their share of commits', () => {
    expect(
      mostEditedFiles([['a.md', 'b.ts'], ['a.md'], ['c.json', 'a.md', 'a.md'], ['b.ts']], 2)
    ).toEqual([
      { path: 'a.md', commits: 3, share: 0.75 },
      { path: 'b.ts', commits: 2, share: 0.5 },
    ]);
  });

  it('lists files at or over the line threshold, largest first', () => {
    expect(
      largeFiles([
        { path: 'src/small.ts', lines: 899 },
        { path: 'src/at.ts', lines: 900 },
        { path: 'src/big.ts', lines: 1200 },
      ])
    ).toEqual([
      { path: 'src/big.ts', lines: 1200 },
      { path: 'src/at.ts', lines: 900 },
    ]);
  });

  it('leaves tests, stories and test support out of production source', () => {
    const production = [
      'src/a.ts',
      'src/client/b.tsx',
      'src/backend/testing.ts',
      'src/lib/fixtures.ts',
      'src/lib/fixtures/claude.ts',
    ];
    const excluded = [
      'src/a.test.ts',
      'src/client/b.stories.tsx',
      'src/backend/testing/setup.ts',
      'src/test-utils/deferred.ts',
      'src/shared/pr.test-helpers.ts',
      'src/backend/agent-ledger.test-support.ts',
      'src/client/form.test-harness.tsx',
      'src/client/event.story-fixtures.ts',
      'src/lib/claude.fixture.ts',
      'src/backend/event-delivery.test-support.integration.ts',
      'src/lib/claude.fixture.d.ts',
    ];
    expect(production.filter(isProductionSource)).toEqual(production);
    expect(excluded.filter(isProductionSource)).toEqual([]);
  });

  it('breaks ties by plain string order, not locale order', () => {
    expect(mostEditedFiles([['a.ts', 'B.ts']]).map((file) => file.path)).toEqual(['B.ts', 'a.ts']);
    expect(
      largeFiles([
        { path: 'src/a.ts', lines: 900 },
        { path: 'src/B.ts', lines: 900 },
      ]).map((file) => file.path)
    ).toEqual(['src/B.ts', 'src/a.ts']);
  });
});
