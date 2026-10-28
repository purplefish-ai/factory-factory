import { describe, expect, it, vi } from 'vitest';
import type { SnapshotUpdateInput } from '@/backend/services/workspace';
import { LinearMergeCompletion } from './linear-merge-completion.orchestrator';

type Projection = Pick<SnapshotUpdateInput, 'prSummary' | 'prState'>;
const identity = { prNumber: 7, prUrl: 'https://github.com/org/repo/pull/7' };
const merged = { ...identity, prState: 'MERGED' as const };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Drain only promise continuations: all external work is controlled by barriers below.
async function settle() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

function harness() {
  const dependencies = {
    readLegacyProjection: vi
      .fn<(id: string) => Promise<Projection | null>>()
      .mockResolvedValue(null),
    getLinearContext: vi
      .fn<(id: string) => Promise<{ apiKey: string; linearIssueId: string } | null>>()
      .mockResolvedValue({ apiKey: 'key', linearIssueId: 'issue' }),
    markIssueCompleted: vi
      .fn<(key: string, issue: string) => Promise<boolean>>()
      .mockResolvedValue(true),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  return { ...dependencies, owner: new LinearMergeCompletion(dependencies), dependencies };
}

function summary(state: 'OPEN' | 'CLOSED' | 'MERGED'): NonNullable<Projection['prSummary']> {
  return {
    totalCount: 2,
    openCount: state === 'OPEN' ? 1 : 0,
    hasNonterminal: state === 'OPEN',
    state,
    ciStatus: 'SUCCESS',
    hasMergeConflict: false,
    ratchetState: 'IDLE',
  };
}

describe('Linear merge completion protocol', () => {
  it('reserves before awaiting and completes accepted projections without a legacy read', async () => {
    const { owner, readLegacyProjection, getLinearContext, markIssueCompleted } = harness();
    owner.observeAcceptedProjection('ws', merged);
    owner.observeAcceptedProjection('ws', merged);
    expect(getLinearContext).not.toHaveBeenCalled();
    await settle();
    expect(readLegacyProjection).not.toHaveBeenCalled();
    expect(getLinearContext).toHaveBeenCalledExactlyOnceWith('ws');
    expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('key', 'issue');
    owner.observeAcceptedProjection('ws', merged);
    await settle();
    expect(markIssueCompleted).toHaveBeenCalledTimes(1);
  });

  it.each([
    { projection: null, transitions: 1 },
    { projection: {}, transitions: 0 },
    { projection: { prState: 'OPEN' }, transitions: 0 },
    { projection: { prState: 'CLOSED' }, transitions: 0 },
    { projection: { prState: 'MERGED', prSummary: summary('CLOSED') }, transitions: 0 },
    { projection: { prState: 'MERGED' }, transitions: 1 },
  ] satisfies Array<{ projection: Projection | null; transitions: number }>)(
    'preserves the legacy projection gate (%j)',
    async ({ projection, transitions }) => {
      const { owner, readLegacyProjection, markIssueCompleted } = harness();
      readLegacyProjection.mockResolvedValue(projection);
      owner.observeLegacy('ws', identity, 'MERGED');
      await settle();
      expect(readLegacyProjection).toHaveBeenCalledExactlyOnceWith('ws');
      expect(markIssueCompleted).toHaveBeenCalledTimes(transitions);
    }
  );

  it.each([
    { ...merged, prNumber: null },
    { ...merged, prSummary: summary('OPEN') },
    { ...merged, prSummary: summary('CLOSED') },
  ])(
    'does not start accepted completion without merged aggregate and selected number (%j)',
    async (fields) => {
      const { owner, getLinearContext, readLegacyProjection } = harness();
      owner.observeAcceptedProjection('ws', fields);
      await settle();
      expect(getLinearContext).not.toHaveBeenCalled();
      expect(readLegacyProjection).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'learns omitted URLs and distinguishes a later known repository (settled: %s)',
    async (settled) => {
      const { owner, markIssueCompleted } = harness();
      owner.observeLegacy('ws', { prNumber: 7 }, 'MERGED');
      if (settled) {
        await settle();
      }
      owner.observeLegacy('ws', identity, 'MERGED');
      owner.observeLegacy('ws', { prNumber: 7 }, 'MERGED');
      await settle();
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
      owner.observeLegacy(
        'ws',
        { ...identity, prUrl: 'https://github.com/org/other/pull/7' },
        'MERGED'
      );
      await settle();
      expect(markIssueCompleted).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['missing context', 'false', 'throw'] as const)(
    'retries %s on a later observation without spinning',
    async (failure) => {
      const { owner, getLinearContext, markIssueCompleted } = harness();
      if (failure === 'missing context') {
        getLinearContext.mockResolvedValueOnce(null);
      } else if (failure === 'false') {
        markIssueCompleted.mockResolvedValueOnce(false);
      } else {
        markIssueCompleted.mockRejectedValueOnce(new Error('unavailable'));
      }
      owner.observeAcceptedProjection('ws', merged);
      owner.observeAcceptedProjection('ws', merged);
      await settle();
      expect(getLinearContext).toHaveBeenCalledTimes(1);
      owner.observeAcceptedProjection('ws', merged);
      await settle();
      expect(getLinearContext).toHaveBeenCalledTimes(2);
      expect(markIssueCompleted).toHaveBeenLastCalledWith('key', 'issue');
    }
  );

  it('uses accepted merged retry intent after a stale legacy read without another read', async () => {
    const { owner, readLegacyProjection, markIssueCompleted } = harness();
    const read = deferred<Projection | null>();
    readLegacyProjection.mockReturnValueOnce(read.promise);
    owner.observeLegacy('ws', identity, 'MERGED');
    owner.observeAcceptedProjection('ws', merged);
    read.resolve({ prState: 'OPEN' });
    await settle();
    expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('key', 'issue');
    expect(readLegacyProjection).toHaveBeenCalledTimes(1);
  });

  it('retains the latest accepted retry projection while the legacy read is running', async () => {
    const { owner, readLegacyProjection, markIssueCompleted } = harness();
    const read = deferred<Projection | null>();
    readLegacyProjection.mockReturnValueOnce(read.promise);
    owner.observeLegacy('ws', identity, 'MERGED');
    owner.observeAcceptedProjection('ws', merged);
    owner.observeAcceptedProjection('ws', { ...merged, prState: 'CLOSED' });
    read.resolve({ prState: 'OPEN' });
    await settle();
    expect(markIssueCompleted).not.toHaveBeenCalled();
    expect(readLegacyProjection).toHaveBeenCalledTimes(1);
    owner.observeAcceptedProjection('ws', merged);
    await settle();
    expect(markIssueCompleted).toHaveBeenCalledTimes(1);
    expect(readLegacyProjection).toHaveBeenCalledTimes(1);
  });

  it('retries pending legacy completion on CLOSED and isolates workspace tracking', async () => {
    const { owner, readLegacyProjection, markIssueCompleted } = harness();
    readLegacyProjection.mockResolvedValueOnce({ prState: 'OPEN' });
    owner.observeLegacy('ws', identity, 'MERGED');
    await settle();
    expect(markIssueCompleted).not.toHaveBeenCalled();
    owner.observeLegacy('ws', identity, 'CLOSED');
    owner.observeLegacy('other', identity, 'MERGED');
    await settle();
    expect(markIssueCompleted).toHaveBeenCalledTimes(2);
    expect(readLegacyProjection.mock.calls).toEqual([['ws'], ['ws'], ['other']]);
  });

  it('does not let a replaced identity failure delete completed tracking', async () => {
    const { owner, markIssueCompleted } = harness();
    const first = deferred<boolean>();
    markIssueCompleted.mockReturnValueOnce(first.promise);
    owner.observeLegacy('ws', identity, 'MERGED');
    await settle();
    const replacement = { ...identity, prUrl: 'https://github.com/org/other/pull/7' };
    owner.observeLegacy('ws', replacement, 'MERGED');
    await settle();
    first.resolve(false);
    await settle();
    owner.observeLegacy('ws', replacement, 'MERGED');
    await settle();
    expect(markIssueCompleted).toHaveBeenCalledTimes(2);
  });
});

describe.each(['remove', 'stop'] as const)('Linear tracking cleanup: %s', (cleanup) => {
  function clear(h: ReturnType<typeof harness>) {
    if (cleanup === 'remove') {
      h.owner.removeWorkspace('ws');
    } else {
      h.owner.stop();
      h.owner = new LinearMergeCompletion(h.dependencies);
    }
  }

  it.each(['false', 'throw'] as const)(
    'fences late %s finalization against a new running attempt',
    async (result) => {
      const h = harness();
      const first = deferred<boolean>();
      const second = deferred<boolean>();
      h.markIssueCompleted.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      h.owner.observeAcceptedProjection('ws', merged);
      await settle();
      clear(h);
      h.owner.observeAcceptedProjection('ws', merged);
      await settle();
      expect(h.markIssueCompleted).toHaveBeenCalledTimes(2);
      if (result === 'false') {
        first.resolve(false);
      } else {
        first.reject(new Error('late failure'));
      }
      await settle();
      h.owner.observeAcceptedProjection('ws', merged);
      await settle();
      expect(h.markIssueCompleted).toHaveBeenCalledTimes(2);
      second.resolve(true);
      await settle();
      h.owner.observeAcceptedProjection('ws', merged);
      await settle();
      expect(h.markIssueCompleted).toHaveBeenCalledTimes(2);
    }
  );

  it('does not repopulate cleared tracking after a late success', async () => {
    const h = harness();
    const first = deferred<boolean>();
    h.markIssueCompleted.mockReturnValueOnce(first.promise);
    h.owner.observeAcceptedProjection('ws', merged);
    await settle();
    clear(h);
    first.resolve(true);
    await settle();
    h.owner.observeAcceptedProjection('ws', merged);
    await settle();
    expect(h.markIssueCompleted).toHaveBeenCalledTimes(2);
  });

  it('does not retry a cleared read with queued retry intent', async () => {
    const h = harness();
    const read = deferred<Projection | null>();
    h.readLegacyProjection.mockReturnValueOnce(read.promise);
    h.owner.observeLegacy('ws', identity, 'MERGED');
    h.owner.observeLegacy('ws', identity, 'CLOSED');
    clear(h);
    read.resolve({ prState: 'OPEN' });
    await settle();
    expect(h.readLegacyProjection).toHaveBeenCalledTimes(1);
    expect(h.markIssueCompleted).not.toHaveBeenCalled();
    h.owner.observeAcceptedProjection('ws', merged);
    await settle();
    expect(h.markIssueCompleted).toHaveBeenCalledTimes(1);
  });

  it.each(['projection', 'context'] as const)(
    'allows admitted work awaiting %s to continue',
    async (stage) => {
      const h = harness();
      const read = deferred<Projection | null>();
      const context = deferred<{ apiKey: string; linearIssueId: string } | null>();
      if (stage === 'projection') {
        h.readLegacyProjection.mockReturnValueOnce(read.promise);
      } else {
        h.getLinearContext.mockReturnValueOnce(context.promise);
      }
      h.owner.observeLegacy('ws', identity, 'MERGED');
      await settle();
      clear(h);
      read.resolve({ prState: 'MERGED' });
      context.resolve({ apiKey: 'key', linearIssueId: 'issue' });
      await settle();
      expect(h.markIssueCompleted).toHaveBeenCalledExactlyOnceWith('key', 'issue');
      h.owner.observeAcceptedProjection('ws', merged);
      await settle();
      expect(h.markIssueCompleted).toHaveBeenCalledTimes(2);
    }
  );
});
