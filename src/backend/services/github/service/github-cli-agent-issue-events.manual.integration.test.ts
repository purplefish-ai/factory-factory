import { describe, expect, it, vi } from 'vitest';
import { agentEventPayloadSchema } from '@/shared/agent-runtime';
import type { AgentIssueEventPage } from '@/shared/agent-source';

/**
 * Opt-in, read-only check of the event automation parser against a real GitHub
 * issue-events feed. It reads the repository identity and up to three feed pages
 * through `GitHubCLIService` with the local `gh` login and never writes to GitHub:
 *
 *   AGENT_LIVE_GITHUB_REPO=owner/name pnpm test:integration \
 *     src/backend/services/github/service/github-cli-agent-issue-events.manual.integration.test.ts
 *
 * Use a throwaway repository with some labeled and reopened issues. Never run in CI.
 */
const repository = process.env.AGENT_LIVE_GITHUB_REPO;
const describeLive = repository ? describe : describe.skip;
const MAX_PAGES = 3;
type Counts = { rows: number; anchors: number; labeled: number; reopened: number };

/** One feed row is either a cursor anchor or a labeled/reopened payload for this repository. */
function checkRow(
  row: AgentIssueEventPage['events'][number],
  identity: { id: string; name: string },
  counts: Counts
) {
  counts.rows++;
  expect(row.providerEventId).toMatch(/^\d+$/);
  if (!row.payload) {
    counts.anchors++;
    return;
  }
  const payload = agentEventPayloadSchema.parse(row.payload);
  if (payload.provider !== 'GITHUB') {
    throw new Error('A GitHub feed row parsed as another provider');
  }
  expect(payload).toMatchObject({ repositoryId: identity.id, repositoryFullName: identity.name });
  expect(payload.sourceUrl).toMatch(new RegExp(`/issues/${payload.issue.number}$`, 'u'));
  if (payload.action === 'labeled') {
    counts.labeled++;
    expect(payload.issue.addedLabel).toEqual(expect.any(String));
  } else {
    counts.reopened++;
    expect(payload.action).toBe('reopened');
    expect(payload.issue.addedLabel).toBeNull();
  }
}

describeLive('live GitHub issue-events feed', () => {
  it('parses every row of the repository feed into anchors or executable payloads', async () => {
    const { githubCLIService } = await vi.importActual<typeof import('@/backend/services/github')>(
      '@/backend/services/github'
    );
    const signal = AbortSignal.timeout(90_000);
    const target = repository ?? '';
    const identity = await githubCLIService.getAgentRepositoryIdentity(target, signal);
    expect(identity.id).toMatch(/^\d+$/);
    expect(identity.name.toLowerCase()).toBe(target.toLowerCase());

    const counts: Counts = { rows: 0, anchors: 0, labeled: 0, reopened: 0 };
    let page: number | null = 1;
    while (page !== null && page <= MAX_PAGES) {
      const result = await githubCLIService.listAgentIssueEvents(
        { repository: identity.name, repositoryId: identity.id, page, perPage: 100 },
        signal
      );
      expect(result.events.length).toBeLessThanOrEqual(100);
      const ids = result.events.map((row) => row.providerEventId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const row of result.events) {
        checkRow(row, identity, counts);
      }
      expect(result.nextPage === null || result.nextPage === page + 1).toBe(true);
      page = result.nextPage;
    }
    // The repository must exercise the executable path, not only cursor anchors.
    expect(counts.labeled + counts.reopened, JSON.stringify(counts)).toBeGreaterThan(0);
  }, 120_000);
});
