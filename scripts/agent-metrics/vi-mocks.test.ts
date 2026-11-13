import { describe, expect, it } from 'vitest';
import { capsuleNames, classifyMockTarget, viMockCounts } from './vi-mocks';

describe('vi.mock metrics', () => {
  it('classifies vi.mock targets', () => {
    const capsules = capsuleNames([
      'src/backend/services/session/index.ts',
      'src/backend/services/workspace/index.ts',
      'src/backend/services/github/index.ts',
      'src/backend/services/github/service/github-cli.service.ts',
      'src/backend/services/logger.service.ts',
    ]);
    expect([...capsules].toSorted()).toEqual(['github', 'session', 'workspace']);
    const cases: [string | null, string][] = [
      ['@/client/lib/trpc', 'client modules'],
      ['@/components/ui/button', 'client modules'],
      ['@/hooks/use-mobile', 'client modules'],
      ['@/lib/image-utils', 'client modules'],
      ['node:fs', 'npm and Node'],
      ['@tanstack/react-query', 'npm and Node'],
      ['@/backend/services/github', 'capsule barrels'],
      ['@/backend/services/session/index', 'capsule barrels'],
      ['./helper', 'relative paths'],
      ['../shared', 'relative paths'],
      ['@/backend/db', 'other backend'],
      ['@/backend/services/logger.service', 'root infrastructure services'],
      ['@/backend/services/session/service/chat/chat.service', 'session internals'],
      ['@/backend/services/workspace/resources/workspace.accessor', 'workspace internals'],
      ['@/backend/services/github/service/github-cli.service', 'other capsule internals'],
      ['@/shared/core', 'other'],
      ['@prisma-gen/client', 'other'],
      [null, 'other'],
    ];
    for (const [target, expected] of cases) {
      expect(classifyMockTarget(target, capsules), String(target)).toBe(expected);
    }
  });

  it('counts vi.mock calls, including multi-line and non-literal targets', () => {
    const counts = viMockCounts(
      [
        {
          path: 'src/a.test.ts',
          content: [
            "vi.mock('node:fs');",
            'vi.mock(',
            "  '@/backend/services/session/service/x',",
            '  () => ({})',
            ');',
            'vi.mock(modulePath);',
            "vi.doMock('ignored');",
          ].join('\n'),
        },
        { path: 'src/b.test.ts', content: 'it("works", () => {});' },
      ],
      new Set(['session'])
    );
    expect(counts).toMatchObject({ calls: 3, filesWithMocks: 1, testFiles: 2 });
    expect(counts.byTarget).toMatchObject({
      'npm and Node': 1,
      'session internals': 1,
      other: 1,
      'client modules': 0,
    });
  });

  it('counts calls, not vi.mock text in strings, templates or comments', () => {
    const counts = viMockCounts(
      [
        {
          path: 'src/fixture.test.tsx',
          content: [
            'const source = "vi.mock(\'node:fs\')";',
            "const template = `vi.mock('node:path')`;",
            "// vi.mock('node:os')",
            "vi.mock('@/client/lib/trpc');",
            `vi.mock(\`./\${name}\`);`,
            'const element = <div />;',
          ].join('\n'),
        },
        { path: 'src/text-only.test.ts', content: 'const text = \'vi.mock("node:fs")\';' },
      ],
      new Set()
    );
    expect(counts).toMatchObject({ calls: 2, filesWithMocks: 1, testFiles: 2 });
    expect(counts.byTarget).toMatchObject({
      'client modules': 1,
      'npm and Node': 0,
      'relative paths': 0,
      other: 1,
    });
  });
});
