import { describe, expect, it } from 'vitest';
import { ciMetrics } from './ci-runs';
import type { AgentMetrics } from './collect';
import { pullRequestMetrics } from './pull-requests';
import { renderMarkdown } from './render';
import { guidanceSize } from './tree';
import { viMockCounts } from './vi-mocks';

describe('renderMarkdown', () => {
  it('renders every section', () => {
    const metrics: AgentMetrics = {
      version: 1,
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
        pullRequests: pullRequestMetrics([
          {
            number: 1,
            title: 'Add a',
            body: '',
            createdAt: '2026-11-01T10:00:00Z',
            mergedAt: '2026-11-01T10:30:00Z',
          },
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
