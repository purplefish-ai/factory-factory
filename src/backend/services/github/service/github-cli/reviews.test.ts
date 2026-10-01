import { describe, expect, it, vi } from 'vitest';
import { getChronologicalReviews } from './reviews';

function review(id: string, state: string, submitted_at: string | null = '2026-01-01T00:00:00Z') {
  return { node_id: id, user: { login: 'reviewer' }, state, submitted_at, body: state };
}

describe('getChronologicalReviews', () => {
  it('carries the REST chronological order across pages, preserving submission times', async () => {
    const read = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        [review('opaque-z', 'CHANGES_REQUESTED', '2026-01-02T00:00:00Z')],
        [review('opaque-a', 'APPROVED'), review('pending', 'PENDING', null)],
      ]),
    });
    const reviews = await getChronologicalReviews('owner/repo', 42, read);
    expect(reviews).toEqual([
      {
        id: 'opaque-z',
        author: { login: 'reviewer' },
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-01-02T00:00:00Z',
        body: 'CHANGES_REQUESTED',
        chronologicalOrder: 0,
      },
      {
        id: 'opaque-a',
        author: { login: 'reviewer' },
        state: 'APPROVED',
        submittedAt: '2026-01-01T00:00:00Z',
        body: 'APPROVED',
        chronologicalOrder: 1,
      },
      {
        id: 'pending',
        author: { login: 'reviewer' },
        state: 'PENDING',
        submittedAt: null,
        body: 'PENDING',
        chronologicalOrder: 2,
      },
    ]);
    expect(read).toHaveBeenCalledWith(
      ['api', 'repos/owner/repo/pulls/42/reviews?per_page=100', '--paginate', '--slurp'],
      { maxBuffer: 10 * 1024 * 1024 }
    );
  });

  it('retains deleted-author feedback with explicit unknown identity', async () => {
    const read = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        [
          { ...review('deleted', 'CHANGES_REQUESTED'), user: null },
          review('present', 'CHANGES_REQUESTED'),
        ],
      ]),
    });
    expect(await getChronologicalReviews('owner/repo', 42, read)).toEqual([
      expect.objectContaining({
        id: 'deleted',
        author: { login: '(deleted reviewer)', isUnknown: true },
        chronologicalOrder: 0,
        body: 'CHANGES_REQUESTED',
      }),
      expect.objectContaining({ id: 'present', chronologicalOrder: 1 }),
    ]);
  });

  it('preserves same-second review chronology across pages', async () => {
    const read = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        [review('changes', 'CHANGES_REQUESTED')],
        [review('approval', 'APPROVED')],
      ]),
    });
    expect(await getChronologicalReviews('owner/repo', 42, read)).toEqual([
      expect.objectContaining({
        id: 'changes',
        submittedAt: '2026-01-01T00:00:00Z',
        chronologicalOrder: 0,
      }),
      expect.objectContaining({
        id: 'approval',
        submittedAt: '2026-01-01T00:00:00Z',
        chronologicalOrder: 1,
      }),
    ]);
  });

  it('accepts pending reviews without submission time', async () => {
    const { submitted_at: _omitted, ...pending } = review('pending', 'PENDING');
    const read = vi.fn().mockResolvedValue({ stdout: JSON.stringify([[pending]]) });
    expect(await getChronologicalReviews('owner/repo', 42, read)).toEqual([
      expect.objectContaining({ state: 'PENDING', submittedAt: null }),
    ]);
  });

  it('fails closed on malformed review data', async () => {
    const read = vi.fn().mockResolvedValue({ stdout: JSON.stringify([[{ state: 'APPROVED' }]]) });
    await expect(getChronologicalReviews('owner/repo', 42, read)).rejects.toThrow(
      'Invalid gh CLI response'
    );
  });

  it('propagates fetch failure rather than assigning speculative order', async () => {
    const read = vi.fn().mockRejectedValue(new Error('API unavailable'));
    await expect(getChronologicalReviews('owner/repo', 42, read)).rejects.toThrow(
      'API unavailable'
    );
  });
});
