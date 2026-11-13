import { describe, expect, it } from 'vitest';
import { guidanceSize, guideChains, largeFiles, mostEditedFiles } from './tree';

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
});
