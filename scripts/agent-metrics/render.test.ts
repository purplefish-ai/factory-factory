import { describe, expect, it } from 'vitest';
import { ciMetrics } from './ci-runs';
import type { AgentMetrics } from './collect';
import { pullRequestMetrics } from './pull-requests';
import { renderMarkdown, renderReports } from './render';
import { guidanceSize } from './tree';
import { viMockCounts } from './vi-mocks';

function fixture(): AgentMetrics {
  return {
    version: 3,
    github: {
      ci: ciMetrics([
        {
          runId: 1,
          attempt: 1,
          branch: 'x',
          sha: 'k1',
          status: 'completed',
          conclusion: 'success',
          startedAt: '2026-11-01T10:00:00Z',
          updatedAt: '2026-11-01T10:00:00Z',
        },
      ]),
      pullRequests: pullRequestMetrics(
        [
          {
            number: 1,
            title: 'Add a',
            body: '',
            createdAt: '2026-11-01T10:00:00Z',
            mergedAt: '2026-11-01T10:30:00Z',
          },
        ],
        'o/r',
        '2026-11-14T12:00:00Z'
      ),
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
        lintRuleExceptions: 25,
      },
      sessionModuleCycles: null,
    },
  };
}

describe('renderMarkdown', () => {
  it('names the denominator of the follow-up fix share', () => {
    const metrics = fixture();
    metrics.github.pullRequests.merged = 8;
    metrics.github.pullRequests.followUpFixes = {
      fixTitled: 2,
      referencingRecentMerge: 1,
      shareOfMerged: 0.125,
      numbers: [20],
    };
    expect(renderMarkdown(metrics)).toContain(
      '| Fix PRs referencing a PR merged in the previous 7 days | 1 (12.5% of 8 merged PRs): #20 |'
    );
  });

  it('names the counts, the cut-offs and the share of the sandbox section keywords', () => {
    const metrics = fixture();
    metrics.github.pullRequests.sandboxSection = {
      templateMergedAt: '2026-11-13T22:01:22Z',
      keywordInstructionAt: '2026-11-14T12:00:00Z',
      beforeTemplate: 270,
      byContent: { opened: 20, filled: 18, empty: 1, missing: 1, shareFilled: 0.9 },
      byKeyword: {
        judged: 10,
        driven: 3,
        notApplicable: 4,
        unlabelled: 1,
        empty: 1,
        missing: 1,
        shareDriven: 0.5,
        unclassifiedNumbers: [3, 9, 12],
      },
    };
    const markdown = renderMarkdown(metrics);
    expect(markdown).toContain(
      '| PRs opened since the "Driven in the sandbox" keyword instruction merged at 2026-11-14T12:00:00Z | driven 3, not applicable 4, unlabelled 1, empty 1, missing 1 of 10; driven among those not marked "does not apply": 3 of 6 (50.0%); unclassified: #3, #9, #12 |'
    );
    expect(markdown).toContain(
      '| PRs opened before the keyword instruction: "Driven in the sandbox" section | since the template merged at 2026-11-13T22:01:22Z, judged only by text: filled 18, empty 1, missing 1 of 20 (90.0% filled); opened before the template and not judged: 270 |'
    );
  });

  it('writes the JSON to the file while printing the Markdown, from one collection', () => {
    const metrics = fixture();
    const reports = renderReports(metrics, { json: false, jsonFile: 'agent-metrics.json' });
    expect(reports.stdout).toBe(renderMarkdown(metrics));
    expect(JSON.parse(reports.file ?? '')).toEqual(JSON.parse(JSON.stringify(metrics)));
    expect(reports.file).toMatch(/\n$/);
  });

  it('prints the JSON with --json, and writes no file without --json-file', () => {
    const metrics = fixture();
    const printed = renderReports(metrics, { json: true, jsonFile: null });
    expect(JSON.parse(printed.stdout)).toEqual(JSON.parse(JSON.stringify(metrics)));
    expect(printed.file).toBeNull();
    expect(renderReports(metrics, { json: false, jsonFile: null })).toEqual({
      stdout: renderMarkdown(metrics),
      file: null,
    });
    expect(renderReports(metrics, { json: true, jsonFile: 'x.json' }).file).toBe(printed.stdout);
  });

  it('carries the sandbox section numbers in the JSON under stable keys', () => {
    const metrics = fixture();
    expect(JSON.parse(renderReports(metrics, { json: true, jsonFile: null }).stdout)).toMatchObject(
      {
        version: 3,
        github: {
          pullRequests: {
            sandboxSection: {
              templateMergedAt: '2026-11-13T22:01:22Z',
              keywordInstructionAt: '2026-11-14T12:00:00Z',
              beforeTemplate: 1,
              byContent: { opened: 0, filled: 0, empty: 0, missing: 0, shareFilled: null },
              byKeyword: {
                judged: 0,
                driven: 0,
                notApplicable: 0,
                unlabelled: 0,
                empty: 0,
                missing: 0,
                shareDriven: null,
                unclassifiedNumbers: [],
              },
            },
          },
        },
      }
    );
  });

  it('formats every count', () => {
    const metrics = fixture();
    const { ci, pullRequests } = metrics.github;
    const { tree } = metrics;
    const count = 1234;
    ci.runs = count;
    ci.attempts = count;
    ci.firstRun = {
      branches: count,
      decided: count,
      greenOnFirstRun: count,
      greenShare: 1,
      branchesWithFailure: count,
    };
    ci.pushesPerBranch.count = count;
    ci.successfulDurationMinutes.count = count;
    ci.failedThenPassedCommits = count;
    pullRequests.merged = count;
    pullRequests.openToMergeHours.count = count;
    pullRequests.followUpFixes.fixTitled = count;
    pullRequests.followUpFixes.referencingRecentMerge = count;
    tree.mostEditedFiles = { commits: count, files: [{ path: 'a.md', commits: count, share: 1 }] };
    tree.largeProductionFiles.count = count;
    tree.viMocks.byTarget.other = count;
    tree.baselines = {
      unusedCodeProduction: count,
      unusedCodeExports: count,
      fileLength: count,
      lintRuleExceptions: count,
    };
    tree.sessionModuleCycles = count;
    const markdown = renderMarkdown(metrics);
    expect(markdown).not.toMatch(/(?<![\d,])1234(?!\d)/);
    expect(markdown.match(/1,234/g)).toHaveLength(24);
  });

  it('escapes pipes and backticks in paths', () => {
    const metrics = fixture();
    metrics.tree.guideChains = [
      { directory: 'docs/a|b', guides: ['AGENTS.md', 'docs/a|b/AGENTS.md'], lines: 2, tokens: 3 },
    ];
    metrics.tree.mostEditedFiles.files = [
      { path: 'src/`tick`.ts', commits: 1, share: 1 },
      { path: '`lead.ts', commits: 1, share: 1 },
    ];
    metrics.tree.largeProductionFiles.files = [{ path: 'src/a|`b`.ts', lines: 950 }];
    const markdown = renderMarkdown(metrics);
    expect(markdown).toContain('| `docs/a\\|b` | `AGENTS.md` → `docs/a\\|b/AGENTS.md` | 2 | 3 |');
    expect(markdown).toContain('| ``src/`tick`.ts`` | 1 | 100.0% |');
    expect(markdown).toContain('| `` `lead.ts `` | 1 | 100.0% |');
    expect(markdown).toContain('- ``src/a|`b`.ts``: 950');
  });

  it('keeps line breaks and backslashed pipes in paths from breaking a table row', () => {
    const metrics = fixture();
    metrics.tree.mostEditedFiles.files = [
      { path: 'docs/new\nline\r.md', commits: 1, share: 1 },
      { path: 'src/a\\|b.ts', commits: 1, share: 1 },
    ];
    const markdown = renderMarkdown(metrics);
    expect(markdown).toContain('| `docs/new\\nline\\r.md` | 1 | 100.0% |');
    expect(markdown).toContain('| `src/a\\\\\\|b.ts` | 1 | 100.0% |');
  });

  it("states each window's limits", () => {
    const markdown = renderMarkdown(fixture());
    expect(markdown).toContain(
      'CI: 1 `pull_request` runs of `ci.yml` (1 attempts), started 2026-11-01T10:00:00Z to 2026-11-01T10:00:00Z (the run window). Only runs in the run window count: a branch whose first run predates it is judged by its first run inside it.'
    );
    expect(markdown).toContain(
      'Pull requests: 1 merged, 2026-11-01T10:30:00Z to 2026-11-01T10:30:00Z (the PR window). A fix PR counts as a follow-up only through references to PRs merged in the PR window; references to PRs outside it are not counted.'
    );
  });

  it('renders every section', () => {
    expect(renderMarkdown(fixture())).toBe(
      [
        '# Agent workflow metrics',
        '',
        'Tree at `abc123`.',
        '',
        '## Pull requests and CI',
        '',
        'CI: 1 `pull_request` runs of `ci.yml` (1 attempts), started 2026-11-01T10:00:00Z to 2026-11-01T10:00:00Z (the run window). Only runs in the run window count: a branch whose first run predates it is judged by its first run inside it.',
        'Pull requests: 1 merged, 2026-11-01T10:30:00Z to 2026-11-01T10:30:00Z (the PR window). A fix PR counts as a follow-up only through references to PRs merged in the PR window; references to PRs outside it are not counted.',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| PR branches green on first non-cancelled run | 1 of 1 (100.0%) |',
        '| PR branches with any failed run | 0 of 1 |',
        '| Pushes per PR branch | median 1, p90 1 (n=1) |',
        '| CI duration, successful runs | median 0 min, p90 0 min (n=1) |',
        '| Commits that failed then passed | 0 |',
        '| Open to merge | median 0.5 h, p90 0.5 h (n=1) |',
        '| Merged PRs titled with a fix verb | 0 of 1 |',
        '| Fix PRs referencing a PR merged in the previous 7 days | 0 (0.0% of 1 merged PRs) |',
        '| PRs opened since the "Driven in the sandbox" keyword instruction merged at 2026-11-14T12:00:00Z | driven 0, not applicable 0, unlabelled 0, empty 0, missing 0 of 0; driven among those not marked "does not apply": 0 of 0 (n/a); unclassified: none |',
        '| PRs opened before the keyword instruction: "Driven in the sandbox" section | since the template merged at 2026-11-13T22:01:22Z, judged only by text: filled 0, empty 0, missing 0 of 0 (n/a filled); opened before the template and not judged: 1 |',
        '',
        '## Guidance',
        '',
        '| Directory | Guide chain | Lines | Estimated tokens |',
        '| --- | --- | --- | --- |',
        '| `.` | `AGENTS.md` | 70 | 830 |',
        '',
        'Guidance: 0 lines (`AGENTS.md` 0, `docs/architecture` 0) against 0 production source lines under `src/`: n/a per 1,000.',
        '',
        '## Most-edited files (last 1 commits)',
        '',
        '| File | Commits | Share |',
        '| --- | --- | --- |',
        '| `a.md` | 1 | 100.0% |',
        '',
        '## Production files of 900 lines or more: 1',
        '',
        '- `src/a.ts`: 950',
        '',
        '## `vi.mock` calls',
        '',
        '0 calls in 0 of 0 test files under `src/`.',
        '',
        '| Target | Calls |',
        '| --- | --- |',
        '| client modules | 0 |',
        '| npm and Node | 0 |',
        '| capsule barrels | 0 |',
        '| relative paths | 0 |',
        '| other backend | 0 |',
        '| root infrastructure services | 0 |',
        '| session internals | 0 |',
        '| workspace internals | 0 |',
        '| other capsule internals | 0 |',
        '| other | 0 |',
        '',
        '## Baselines and exceptions',
        '',
        '| List | Entries |',
        '| --- | --- |',
        '| `scripts/unused-code-baseline.json` production | 71 |',
        '| `scripts/unused-code-baseline.json` exports | 273 |',
        '| `scripts/file-length-baseline.json` | 11 |',
        '| Lint rule exceptions (`lint-rules/rules/*.exceptions.json`) | 25 |',
        '| `sessionModuleCycles` | n/a (no `src/backend/services/session/modules.ts`) |',
        '',
      ].join('\n')
    );
  });
});
