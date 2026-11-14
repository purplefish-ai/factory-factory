import { CancelledError, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Pins the React Query behaviour that ProjectWorkspaceCacheReconciler and the
 * detail reconciler depend on (workspace-cache-reconciler.ts). If an upgrade
 * changes it, reconciliation can silently stop running; update the reconciler
 * and src/client/lib/AGENTS.md before adjusting these assertions.
 */
const clients: QueryClient[] = [];
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
  for (const client of clients.splice(0)) {
    client.clear();
  }
});

function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const queryKey = ['workspace'];
  const query = () => client.getQueryCache().find({ queryKey, exact: true });
  return { client, queryKey, query };
}

describe('query-core structuralSharing commit contract', () => {
  it('calls a function structuralSharing synchronously at the fetch success commit', async () => {
    const { client, queryKey } = fixture();
    client.setQueryData(queryKey, { name: 'cached' });
    const commits: unknown[] = [];
    const sharing = vi.fn((previous: unknown, next: unknown) => {
      commits.push(client.getQueryData(queryKey));
      return { previous, next };
    });
    await client.query({
      queryKey,
      queryFn: () => ({ name: 'http' }),
      structuralSharing: sharing,
      staleTime: 0,
    });
    // It runs before the cache changes and its return value is what commits.
    expect(commits).toEqual([{ name: 'cached' }]);
    expect(client.getQueryData(queryKey)).toEqual({
      previous: { name: 'cached' },
      next: { name: 'http' },
    });
  });

  it('reverts a commit when structuralSharing throws CancelledError({ revert: true })', async () => {
    const { client, queryKey, query } = fixture();
    client.setQueryData(queryKey, { name: 'cached' });
    const result = await client.query({
      queryKey,
      queryFn: () => ({ name: 'http' }),
      structuralSharing: () => {
        throw new CancelledError({ revert: true });
      },
      staleTime: 0,
    });
    // The fetch resolves with the retained data instead of failing.
    expect(result).toEqual({ name: 'cached' });
    expect(client.getQueryData(queryKey)).toEqual({ name: 'cached' });
    expect(query()?.state).toMatchObject({ status: 'success', error: null });
  });

  it('rejects an initial fetch reverted from structuralSharing without an error state', async () => {
    const { client, queryKey, query } = fixture();
    await expect(
      client.query({
        queryKey,
        queryFn: () => ({ name: 'http' }),
        structuralSharing: () => {
          throw new CancelledError({ revert: true });
        },
      })
    ).rejects.toBeInstanceOf(CancelledError);
    expect(query()?.state).toMatchObject({ data: undefined, status: 'pending', error: null });
  });

  it('commits with the options from the latest fetch or observer of the key', async () => {
    const { client, queryKey } = fixture();
    const reconciled = vi.fn((_previous: unknown, next: unknown) => next);
    const plain = vi.fn((_previous: unknown, next: unknown) => next);
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn: () => ({ name: 'observer' }),
      structuralSharing: reconciled,
      staleTime: Number.POSITIVE_INFINITY,
    });
    cleanup.push(observer.subscribe(() => undefined));
    await vi.waitFor(() => expect(reconciled).toHaveBeenCalledOnce());

    // A plain fetch of the same key installs its own options for its commit...
    await client.query({ queryKey, queryFn: () => ({ name: 'plain' }), structuralSharing: plain });
    expect(plain).toHaveBeenCalledOnce();
    expect(reconciled).toHaveBeenCalledOnce();

    // ...and later option-less fetches (invalidation, writes) keep using them.
    await client.invalidateQueries({ queryKey });
    client.setQueryData(queryKey, { name: 'manual' });
    expect(plain).toHaveBeenCalledTimes(3);
    expect(reconciled).toHaveBeenCalledOnce();

    // The observer reinstalls its options when it next sets them.
    observer.setOptions({ ...observer.options });
    await client.invalidateQueries({ queryKey });
    expect(reconciled).toHaveBeenCalledTimes(2);
    expect(plain).toHaveBeenCalledTimes(3);
  });
});
