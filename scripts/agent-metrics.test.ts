import { describe, expect, it } from 'vitest';
import {
  type AgentMetrics,
  attemptFromApi,
  attemptsFromRunList,
  baselineSizes,
  type CiRunAttempt,
  capsuleNames,
  ciMetrics,
  classifyMockTarget,
  distribution,
  failedThenPassedCommits,
  firstRunOutcome,
  followUpFixes,
  guidanceSize,
  guideChains,
  largeFiles,
  lintExceptionEntries,
  type MergedPullRequest,
  mergedPullRequestListSchema,
  mostEditedFiles,
  openToMergeHours,
  parseMetricsArgs,
  percentile,
  pullRequestMetrics,
  pushesPerBranch,
  referencedPullRequestNumbers,
  renderMarkdown,
  runAttemptSchema,
  runListSchema,
  sessionModuleCycleCount,
  startsWithFixVerb,
  successfulDurationMinutes,
  viMockCounts,
} from './agent-metrics';

let nextRunId = 1;

function attempt(
  branch: string,
  sha: string,
  conclusion: string,
  startedAt: string,
  overrides: Partial<CiRunAttempt> = {}
): CiRunAttempt {
  const runId = nextRunId;
  nextRunId += 1;
  return {
    runId,
    attempt: 1,
    branch,
    sha,
    status: 'completed',
    conclusion,
    startedAt,
    updatedAt: startedAt,
    ...overrides,
  };
}

function pullRequest(
  number: number,
  title: string,
  createdAt: string,
  mergedAt: string,
  body = ''
): MergedPullRequest {
  return { number, title, body, createdAt, mergedAt };
}

describe('parseMetricsArgs', () => {
  it('defaults to 300 pull requests and Markdown', () => {
    expect(parseMetricsArgs([])).toEqual({ pullRequests: 300, json: false });
  });

  it('reads --prs and --json', () => {
    expect(parseMetricsArgs(['--prs', '50', '--json'])).toEqual({ pullRequests: 50, json: true });
  });

  it('rejects a missing or non-positive count and unknown flags', () => {
    expect(() => parseMetricsArgs(['--prs'])).toThrow('--prs needs a positive integer');
    expect(() => parseMetricsArgs(['--prs', '0'])).toThrow('--prs needs a positive integer');
    expect(() => parseMetricsArgs(['--markdown'])).toThrow('Unknown argument: --markdown');
  });
});

describe('percentile and distribution', () => {
  it('interpolates between closest ranks', () => {
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.9)).toBe(10);
    expect(percentile([1, 2], 0.9)).toBeCloseTo(1.9);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('rounds the median and p90', () => {
    expect(distribution([1, 2, 2.2], 1)).toEqual({ count: 3, median: 2, p90: 2.2 });
    expect(distribution([], 1)).toEqual({ count: 0, median: null, p90: null });
  });
});

describe('CI run metrics', () => {
  it('passes over a cancelled first run and counts the first real outcome', () => {
    const outcome = firstRunOutcome([
      attempt('cancelled-then-green', 'a1', 'cancelled', '2026-11-01T10:00:00Z'),
      attempt('cancelled-then-green', 'a2', 'success', '2026-11-01T10:05:00Z'),
      attempt('cancelled-then-green', 'a3', 'failure', '2026-11-01T10:10:00Z'),
      attempt('red-then-green', 'b2', 'success', '2026-11-01T11:10:00Z'),
      attempt('red-then-green', 'b1', 'failure', '2026-11-01T11:00:00Z'),
      attempt('green', 'c1', 'success', '2026-11-01T12:00:00Z'),
    ]);
    expect(outcome).toEqual({
      branches: 3,
      decided: 3,
      greenOnFirstRun: 2,
      greenShare: 0.6667,
      branchesWithFailure: 2,
    });
  });

  it('leaves a branch undecided while its first real run is in progress or all are cancelled', () => {
    const outcome = firstRunOutcome([
      attempt('running', 'd1', '', '2026-11-01T10:00:00Z', { status: 'in_progress' }),
      attempt('running', 'd2', 'success', '2026-11-01T10:05:00Z'),
      attempt('only-cancelled', 'e1', 'cancelled', '2026-11-01T10:00:00Z'),
    ]);
    expect(outcome).toMatchObject({ branches: 2, decided: 0, greenOnFirstRun: 0 });
    expect(outcome.greenShare).toBeNull();
  });

  it('counts a failed first attempt even when the re-run went green', () => {
    const latest = attempt('rerun', 'f1', 'success', '2026-11-01T10:20:00Z', { attempt: 2 });
    const first = {
      ...latest,
      attempt: 1,
      conclusion: 'failure',
      startedAt: '2026-11-01T10:00:00Z',
    };
    expect(firstRunOutcome([latest, first])).toMatchObject({
      greenOnFirstRun: 0,
      branchesWithFailure: 1,
    });
    expect(failedThenPassedCommits([latest, first])).toBe(1);
  });

  it('counts distinct pushed commits per branch, including a PR with one push', () => {
    expect(
      pushesPerBranch([
        attempt('one-push', 'g1', 'success', '2026-11-01T10:00:00Z'),
        attempt('one-push', 'g1', 'success', '2026-11-01T10:30:00Z', { attempt: 2 }),
        attempt('three-pushes', 'h1', 'failure', '2026-11-01T10:00:00Z'),
        attempt('three-pushes', 'h2', 'failure', '2026-11-01T10:10:00Z'),
        attempt('three-pushes', 'h3', 'success', '2026-11-01T10:20:00Z'),
      ])
    ).toEqual({ count: 2, median: 2, p90: 2.8 });
  });

  it('measures successful completed runs only, in minutes', () => {
    expect(
      successfulDurationMinutes([
        attempt('x', 'i1', 'success', '2026-11-01T10:00:00Z', {
          updatedAt: '2026-11-01T10:07:00Z',
        }),
        attempt('x', 'i2', 'success', '2026-11-01T11:00:00Z', {
          updatedAt: '2026-11-01T11:05:00Z',
        }),
        attempt('x', 'i3', 'failure', '2026-11-01T12:00:00Z', {
          updatedAt: '2026-11-01T12:30:00Z',
        }),
      ])
    ).toEqual({ count: 2, median: 6, p90: 6.8 });
  });

  it('counts commits that failed and later passed, not passed then failed', () => {
    expect(
      failedThenPassedCommits([
        attempt('x', 'flaky', 'failure', '2026-11-01T10:00:00Z'),
        attempt('x', 'flaky', 'cancelled', '2026-11-01T10:05:00Z'),
        attempt('x', 'flaky', 'success', '2026-11-01T10:10:00Z'),
        attempt('y', 'regressed', 'success', '2026-11-01T10:00:00Z'),
        attempt('y', 'regressed', 'failure', '2026-11-01T10:10:00Z'),
        attempt('z', 'broken', 'failure', '2026-11-01T10:00:00Z'),
      ])
    ).toBe(1);
  });

  it('summarizes runs, attempts and the window', () => {
    const metrics = ciMetrics([
      attempt('x', 'j1', 'success', '2026-11-02T10:00:00Z'),
      attempt('y', 'j2', 'success', '2026-11-01T10:00:00Z'),
    ]);
    expect(metrics).toMatchObject({
      runs: 2,
      attempts: 2,
      window: { from: '2026-11-01T10:00:00Z', to: '2026-11-02T10:00:00Z' },
    });
  });

  it('validates gh run list and run attempt JSON', () => {
    const rows = runListSchema.parse([
      {
        databaseId: 42,
        attempt: 2,
        headBranch: 'feature',
        headSha: 'abc',
        status: 'completed',
        conclusion: 'success',
        startedAt: '2026-11-01T10:00:00Z',
        updatedAt: '2026-11-01T10:07:00Z',
      },
    ]);
    expect(attemptsFromRunList(rows)).toEqual([
      {
        runId: 42,
        attempt: 2,
        branch: 'feature',
        sha: 'abc',
        status: 'completed',
        conclusion: 'success',
        startedAt: '2026-11-01T10:00:00Z',
        updatedAt: '2026-11-01T10:07:00Z',
      },
    ]);
    expect(
      attemptFromApi(
        runAttemptSchema.parse({
          id: 42,
          run_attempt: 1,
          head_branch: 'feature',
          head_sha: 'abc',
          status: 'completed',
          conclusion: 'failure',
          run_started_at: '2026-11-01T09:50:00Z',
          updated_at: '2026-11-01T09:55:00Z',
        })
      )
    ).toMatchObject({ runId: 42, attempt: 1, conclusion: 'failure' });
    expect(runListSchema.safeParse([{ databaseId: 'nope' }]).success).toBe(false);
  });
});

describe('merged pull request metrics', () => {
  it('measures open-to-merge hours', () => {
    expect(
      openToMergeHours([
        pullRequest(1, 'Add a', '2026-11-01T10:00:00Z', '2026-11-01T10:30:00Z'),
        pullRequest(2, 'Add b', '2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z'),
      ])
    ).toEqual({ count: 2, median: 1.25, p90: 1.85 });
  });

  it('recognizes fix verbs at the start of a title', () => {
    expect(startsWithFixVerb('Fix sentence casing')).toBe(true);
    expect(startsWithFixVerb('fix(chat): stop flicker')).toBe(true);
    expect(startsWithFixVerb('Restore full access')).toBe(true);
    expect(startsWithFixVerb('Prevent repeated clicks')).toBe(true);
    expect(startsWithFixVerb('Fixture route for mobile')).toBe(false);
    expect(startsWithFixVerb('Add a fix button')).toBe(false);
  });

  it('extracts referenced pull request numbers', () => {
    expect(
      referencedPullRequestNumbers(
        'Follows #12 and https://github.com/o/r/pull/34. Not a&#39; entity or a/#56 path. #12 again.'
      )
    ).toEqual([12, 34]);
  });

  it('counts fix PRs that reference a PR merged in the previous 7 days', () => {
    const pullRequests = [
      pullRequest(10, 'Add feature', '2026-11-01T09:00:00Z', '2026-11-01T10:00:00Z'),
      pullRequest(11, 'Add old feature', '2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'),
      pullRequest(20, 'Fix feature', '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z', 'After #10.'),
      pullRequest(
        21,
        'Fix old feature',
        '2026-11-03T09:00:00Z',
        '2026-11-03T11:00:00Z',
        'After #11.'
      ),
      pullRequest(22, 'Fix itself', '2026-11-03T09:00:00Z', '2026-11-03T12:00:00Z', 'See #22.'),
      pullRequest(23, 'Add more', '2026-11-03T09:00:00Z', '2026-11-03T13:00:00Z', 'After #10.'),
      pullRequest(24, 'Fix later work', '2026-11-03T09:00:00Z', '2026-11-03T14:00:00Z', '#25'),
      pullRequest(25, 'Add later work', '2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z'),
    ];
    expect(followUpFixes(pullRequests)).toEqual({
      fixTitled: 4,
      referencingRecentMerge: 1,
      share: 0.125,
      numbers: [20],
    });
    expect(pullRequestMetrics(pullRequests)).toMatchObject({
      merged: 8,
      window: { from: '2026-10-01T10:00:00Z', to: '2026-11-04T10:00:00Z' },
    });
  });

  it('validates gh pr list JSON', () => {
    expect(
      mergedPullRequestListSchema.safeParse([
        { number: 1, title: 'x', body: '', createdAt: 'yesterday', mergedAt: 'today' },
      ]).success
    ).toBe(false);
  });
});

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

  it('counts lint exception entries and baseline sizes', () => {
    const lintConfig = {
      rules: { a: ['error', { exceptions: { 'x.ts': 'reason', 'y.ts': 'reason' } }] },
      overrides: [
        {
          rules: {
            b: ['error', { exceptions: {} }],
            c: ['error', { exceptions: { 'z.ts': 'r' } }],
          },
        },
      ],
    };
    expect(lintExceptionEntries(lintConfig)).toBe(3);
    expect(
      baselineSizes(
        {
          version: 1,
          production: {
            'src/a.ts': { disposition: 'maintained-api', reason: 'Kept for the CLI API.' },
          },
          exports: {
            'src/b.ts::exports::b': {
              disposition: 'test-support',
              reason: 'Used by test fixtures.',
            },
            'src/b.ts::types::B': { disposition: 'test-support', reason: 'Used by test fixtures.' },
          },
        },
        { 'src/c.ts': 1200 },
        lintConfig
      )
    ).toEqual({ unusedCodeProduction: 1, unusedCodeExports: 2, fileLength: 1, lintExceptions: 3 });
    expect(() => lintExceptionEntries({ exceptions: ['x.ts'] })).toThrow();
  });

  it('reads the sessionModuleCycles length, or null while the file is absent', () => {
    expect(sessionModuleCycleCount(null)).toBeNull();
    expect(
      sessionModuleCycleCount(
        [
          'export const sessionModules = {};',
          'export const sessionModuleCycles: readonly (readonly [string, string])[] = [',
          "  ['chat', 'dispatch'],",
          "  ['data', 'events'],",
          '] as const;',
        ].join('\n')
      )
    ).toBe(2);
    expect(sessionModuleCycleCount('export const sessionModuleCycles = [];')).toBe(0);
    expect(() => sessionModuleCycleCount('export const sessionModules = {};')).toThrow(
      'no sessionModuleCycles array literal'
    );
  });
});

describe('renderMarkdown', () => {
  it('renders every section', () => {
    const metrics: AgentMetrics = {
      version: 1,
      github: {
        ci: ciMetrics([attempt('x', 'k1', 'success', '2026-11-01T10:00:00Z')]),
        pullRequests: pullRequestMetrics([
          pullRequest(1, 'Add a', '2026-11-01T10:00:00Z', '2026-11-01T10:30:00Z'),
        ]),
      },
      tree: {
        commit: 'abc123',
        guideChains: [{ directory: '.', guides: ['AGENTS.md'], lines: 70, tokens: 830 }],
        guidance: guidanceSize([], [], []),
        mostEditedFiles: { commits: 1, files: [{ path: 'a.md', commits: 1, share: 1 }] },
        largeProductionFiles: {
          threshold: 900,
          count: 1,
          files: [{ path: 'src/a.ts', lines: 950 }],
        },
        viMocks: viMockCounts([], new Set()),
        baselines: {
          unusedCodeProduction: 71,
          unusedCodeExports: 273,
          fileLength: 11,
          lintExceptions: 25,
        },
        sessionModuleCycles: null,
      },
    };
    const markdown = renderMarkdown(metrics);
    expect(markdown).toContain('Tree at `abc123`.');
    expect(markdown).toContain(
      '| PR branches green on first non-cancelled run | 1 of 1 (100.0%) |'
    );
    expect(markdown).toContain('| Open to merge | median 0.5 h, p90 0.5 h (n=1) |');
    expect(markdown).toContain('| `.` | `AGENTS.md` | 70 | 830 |');
    expect(markdown).toContain('| `a.md` | 1 | 100.0% |');
    expect(markdown).toContain('- `src/a.ts`: 950');
    expect(markdown).toContain('| `.oxlintrc.json` rule exceptions | 25 |');
    expect(markdown).toContain(
      '| `sessionModuleCycles` | n/a (no `src/backend/services/session/modules.ts`) |'
    );
  });
});
