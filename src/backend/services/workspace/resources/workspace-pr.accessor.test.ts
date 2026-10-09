import { describe, expect, it, vi } from 'vitest';

const mockWorkspaceFindMany = vi.fn();
const mockPrUpdateMany = vi.fn();
const mockPrFindUnique = vi.fn();

vi.mock('@/backend/db', () => ({
  prisma: {
    workspace: {
      findMany: (...args: unknown[]) => mockWorkspaceFindMany(...args),
    },
    workspacePR: {
      updateMany: (...args: unknown[]) => mockPrUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockPrFindUnique(...args),
    },
  },
}));

import { flattenWorkspacePR, WORKSPACE_PR_DEFAULTS } from './workspace-pr.accessor';

/** A persisted row with every column populated, for flatten round-trips. */
const fullRow = {
  id: 'pr1',
  title: null,
  headRefName: null,
  baseRefName: null,
  revision: 0,
  detachedAt: null,
  observation: null,
  observationEpoch: 0,
  transitionSequence: 0,
  workspaceId: 'ws-1',
  url: 'https://github.com/org/repo/pull/12',
  number: 12,
  state: 'OPEN' as const,
  reviewState: 'APPROVED',
  ciStatus: 'SUCCESS' as const,
  hasMergeConflict: true,
  syncedAt: new Date('2026-07-26T12:00:00.000Z'),
  ciFailedAt: new Date('2026-07-26T10:00:00.000Z'),
  ciLastNotifiedAt: new Date('2026-07-26T10:30:00.000Z'),
  reviewLastCheckedAt: new Date('2026-07-26T09:00:00.000Z'),
  reviewLastCommentId: 'comment-7',
};

describe('flattenWorkspacePR', () => {
  it('maps every column onto its caller-facing pr* name', () => {
    expect(flattenWorkspacePR(fullRow)).toEqual({
      prUrl: 'https://github.com/org/repo/pull/12',
      prNumber: 12,
      prState: 'OPEN',
      prReviewState: 'APPROVED',
      prCiStatus: 'SUCCESS',
      prHasMergeConflict: true,
      prUpdatedAt: new Date('2026-07-26T12:00:00.000Z'),
      prDiscoveryLastCheckedAt: null,
      prDiscoveryRetryCount: 0,
      prDiscoveryNextCheckAt: null,
      prCiFailedAt: new Date('2026-07-26T10:00:00.000Z'),
      prCiLastNotifiedAt: new Date('2026-07-26T10:30:00.000Z'),
      prReviewLastCheckedAt: new Date('2026-07-26T09:00:00.000Z'),
      prReviewLastCommentId: 'comment-7',
    });
  });

  it('maps syncedAt to the prUpdatedAt name callers and the export format use', () => {
    expect(flattenWorkspacePR(fullRow).prUpdatedAt).toEqual(fullRow.syncedAt);
  });

  it('substitutes column defaults for a missing row', () => {
    expect(flattenWorkspacePR(null)).toEqual(WORKSPACE_PR_DEFAULTS);
    expect(flattenWorkspacePR(undefined)).toEqual(WORKSPACE_PR_DEFAULTS);
  });

  it('returns a fresh defaults object each time, so callers cannot mutate it', () => {
    const first = flattenWorkspacePR(null);
    first.prNumber = 99;
    expect(flattenWorkspacePR(null).prNumber).toBeNull();
    expect(WORKSPACE_PR_DEFAULTS.prNumber).toBeNull();
  });
});
