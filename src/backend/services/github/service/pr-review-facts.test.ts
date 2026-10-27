import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ADVERSARIAL_REVIEW_MARKER } from '@/shared/adversarial-review';
import { fetchPRReviewFacts } from './pr-review-facts';

type ReviewPorts = Parameters<typeof fetchPRReviewFacts>[0];
const url = 'https://github.com/org/repo/pull/1';
const updatedAt = '2026-10-01T00:00:00.000Z';
function ports() {
  return {
    readPolicy: vi
      .fn<ReviewPorts['readPolicy']>()
      .mockResolvedValue({ reviewTriggerMode: 'CHANGES_REQUESTED' }),
    readUsername: vi.fn<ReviewPorts['readUsername']>().mockResolvedValue('me'),
    readDetails: vi
      .fn<ReviewPorts['readDetails']>()
      .mockResolvedValue({ updatedAt, reviews: [], comments: [] }),
    readComments: vi.fn<ReviewPorts['readComments']>().mockResolvedValue([]),
    readResolvedIds: vi.fn<ReviewPorts['readResolvedIds']>().mockResolvedValue(new Set()),
  };
}

it('keeps review filtering, stable hashes, paths and timestamp fallbacks in the review owner', async () => {
  const source = ports();
  const marker = `${ADVERSARIAL_REVIEW_MARKER}\nPlease fix this`;
  source.readDetails.mockResolvedValue({
    updatedAt,
    reviews: [
      {
        id: 'own',
        author: { login: 'me' },
        state: 'CHANGES_REQUESTED',
        submittedAt: updatedAt,
        body: 'ignore me',
      },
      {
        id: 'external',
        author: { login: 'reviewer' },
        state: 'CHANGES_REQUESTED',
        submittedAt: 'not a date',
        body: 'fix review',
      },
    ],
    comments: [
      {
        id: 'marker',
        author: { login: 'me' },
        body: marker,
        createdAt: updatedAt,
        updatedAt: 'invalid',
        url: `${url}#marker`,
      },
    ],
  });
  source.readComments.mockResolvedValue([
    {
      id: 1,
      author: { login: 'reviewer' },
      body: 'inline',
      path: 'src/file.ts',
      line: 7,
      createdAt: updatedAt,
      updatedAt: 'bad',
      url: `${url}#1`,
    },
    {
      id: 2,
      author: { login: 'reviewer' },
      body: 'resolved',
      path: 'src/file.ts',
      line: null,
      createdAt: updatedAt,
      updatedAt,
      url: `${url}#2`,
    },
  ]);
  source.readResolvedIds.mockResolvedValue(new Set([2]));
  expect(await fetchPRReviewFacts(source, 'org/repo', 1, url)).toEqual({
    reviewsComplete: true,
    resolvedReviewIds: ['comment:2'],
    actionableReviews: [
      {
        identity: 'review:external',
        author: 'reviewer',
        body: 'fix review',
        contentHash: createHash('sha256').update('fix review').digest('hex'),
        path: null,
        line: null,
        url: `${url}#pullrequestreview-external`,
        activityAt: updatedAt,
      },
      {
        identity: 'comment:1',
        author: 'reviewer',
        body: 'inline',
        contentHash: createHash('sha256').update('inline').digest('hex'),
        path: 'src/file.ts',
        line: 7,
        url: `${url}#1`,
        activityAt: updatedAt,
      },
      {
        identity: 'conversation:marker',
        author: 'me',
        body: marker,
        contentHash: createHash('sha256').update(marker).digest('hex'),
        path: null,
        line: null,
        url: `${url}#marker`,
        activityAt: updatedAt,
      },
    ],
  });
});

it('never uses unknown identity to disable self-review filtering', async () => {
  const source = ports();
  source.readUsername.mockResolvedValue(null);
  expect(await fetchPRReviewFacts(source, 'org/repo', 1, url)).toEqual({
    reviewsComplete: false,
    actionableReviews: [],
    resolvedReviewIds: [],
  });
  expect(source.readDetails).not.toHaveBeenCalled();
});

it('does not claim known resolutions when another enrichment source failed', async () => {
  const source = ports();
  source.readResolvedIds.mockResolvedValue(new Set([1]));
  source.readComments.mockRejectedValue(new Error('comments unavailable'));
  expect(await fetchPRReviewFacts(source, 'org/repo', 1, url)).toEqual({
    reviewsComplete: false,
    actionableReviews: [],
    resolvedReviewIds: [],
  });
});

it('keeps epoch fallback and pagination incompleteness explicit', async () => {
  const source = ports();
  source.readDetails.mockResolvedValue({
    updatedAt: 'invalid',
    reviews: [
      {
        id: 'external',
        author: { login: 'reviewer' },
        state: 'CHANGES_REQUESTED',
        submittedAt: null,
        body: 'fix',
      },
    ],
    comments: [],
  });
  source.readResolvedIds.mockImplementation((_repo, _number, _signal, incomplete) => {
    incomplete?.();
    return Promise.resolve(new Set([3]));
  });
  expect(await fetchPRReviewFacts(source, 'org/repo', 1, url)).toMatchObject({
    reviewsComplete: false,
    resolvedReviewIds: ['comment:3'],
    actionableReviews: [
      expect.objectContaining({
        identity: 'review:external',
        activityAt: '1970-01-01T00:00:00.000Z',
      }),
    ],
  });
});

it('passes the exact abort signal to every review I/O capability', async () => {
  const source = ports();
  const signal = new AbortController().signal;
  await fetchPRReviewFacts(source, 'org/repo', 1, url, signal);
  expect(source.readUsername).toHaveBeenCalledWith(signal);
  expect(source.readDetails).toHaveBeenCalledWith('org/repo', 1, signal);
  expect(source.readComments).toHaveBeenCalledWith(
    'org/repo',
    1,
    undefined,
    signal,
    expect.any(Function)
  );
  expect(source.readResolvedIds).toHaveBeenCalledWith('org/repo', 1, signal, expect.any(Function));
});
