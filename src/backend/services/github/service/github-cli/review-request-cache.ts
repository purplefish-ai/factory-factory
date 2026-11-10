import type { ReviewRequestedPR } from './types';

export const REVIEW_REQUEST_CACHE_TTL_MS = 2 * 60_000;

const noop = () => undefined;

type Fetch = (repository: string | undefined) => Promise<ReviewRequestedPR[]>;

/**
 * Stale-while-revalidate cache for review-request searches, keyed by repository
 * (case-insensitive) or the global search. A stale entry is returned at once
 * while one background fetch refreshes it; a failed refresh keeps the stale
 * value and the next read retries. `forceRefresh` waits for a fetch that starts
 * after the call. `invalidate` drops entries and stops fetches already running
 * from repopulating them.
 */
export class ReviewRequestCache {
  private readonly entries = new Map<string, { prs: ReviewRequestedPR[]; fetchedAt: number }>();
  private readonly refreshes = new Map<
    string,
    { promise: Promise<ReviewRequestedPR[]>; generation: number }
  >();
  private generation = 0;

  constructor(private readonly ttlMs = REVIEW_REQUEST_CACHE_TTL_MS) {}

  get(
    repository: string | undefined,
    fetch: Fetch,
    options: { forceRefresh?: boolean } = {}
  ): Promise<ReviewRequestedPR[]> {
    const key = repository?.toLowerCase() ?? '';
    if (!options.forceRefresh) {
      const pending = this.refreshes.get(key);
      const current = pending?.generation === this.generation ? pending : undefined;
      const cached = this.entries.get(key);
      if (cached) {
        if (Date.now() - cached.fetchedAt >= this.ttlMs && !current) {
          this.refresh(key, repository, fetch).catch(noop);
        }
        return Promise.resolve(cached.prs);
      }
      if (current) {
        return current.promise;
      }
    }
    return this.refresh(key, repository, fetch);
  }

  invalidate(): void {
    this.generation++;
    this.entries.clear();
  }

  clear(): void {
    this.invalidate();
    this.refreshes.clear();
  }

  private refresh(
    key: string,
    repository: string | undefined,
    fetch: Fetch
  ): Promise<ReviewRequestedPR[]> {
    const previous = this.refreshes.get(key)?.promise;
    const generation = this.generation;
    // Start after an earlier fetch settles so read singleflight cannot return its older result.
    const promise = (previous === undefined ? Promise.resolve() : previous.then(noop, noop))
      .then(() => fetch(repository))
      .then((prs) => {
        if (generation === this.generation) {
          this.entries.set(key, { prs, fetchedAt: Date.now() });
        }
        return prs;
      })
      .finally(() => {
        if (this.refreshes.get(key)?.promise === promise) {
          this.refreshes.delete(key);
        }
      });
    this.refreshes.set(key, { promise, generation });
    return promise;
  }
}
