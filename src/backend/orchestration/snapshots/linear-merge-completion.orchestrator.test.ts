import { describe, expect, it, vi } from 'vitest';
import type { SnapshotUpdateInput } from '@/backend/services/workspace';
import { LinearMergeCompletion } from './linear-merge-completion.orchestrator';

type Projection = Pick<SnapshotUpdateInput, 'prSummary' | 'prState'>;
const merged = {
  prNumber: 7,
  prUrl: 'https://github.com/org/repo/pull/7',
  prState: 'MERGED' as const,
};

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
  it('reserves before awaiting and completes accepted projections once', async () => {
    const { owner, getLinearContext, markIssueCompleted } = harness();
    owner.observeAcceptedProjection('ws', merged);
    owner.observeAcceptedProjection('ws', merged);
    // The first observation reserved the PR before its context lookup settled.
    expect(getLinearContext).toHaveBeenCalledOnce();
    await settle();
    expect(getLinearContext).toHaveBeenCalledExactlyOnceWith('ws');
    expect(markIssueCompleted).toHaveBeenCalledExactlyOnceWith('key', 'issue');
    owner.observeAcceptedProjection('ws', merged);
    await settle();
    expect(markIssueCompleted).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...merged, prNumber: null },
    { ...merged, prSummary: summary('OPEN') },
    { ...merged, prSummary: summary('CLOSED') },
  ])(
    'does not start accepted completion without merged aggregate and selected number (%j)',
    async (fields) => {
      const { owner, getLinearContext } = harness();
      owner.observeAcceptedProjection('ws', fields);
      await settle();
      expect(getLinearContext).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])(
    'learns omitted URLs and distinguishes a later known repository (settled: %s)',
    async (settled) => {
      const { owner, markIssueCompleted } = harness();
      owner.observeAcceptedProjection('ws', { ...merged, prUrl: null });
      if (settled) {
        await settle();
      }
      owner.observeAcceptedProjection('ws', merged);
      owner.observeAcceptedProjection('ws', { ...merged, prUrl: null });
      await settle();
      expect(markIssueCompleted).toHaveBeenCalledTimes(1);
      owner.observeAcceptedProjection('ws', {
        ...merged,
        prUrl: 'https://github.com/org/other/pull/7',
      });
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

  it('does not let a replaced identity failure delete completed tracking', async () => {
    const { owner, markIssueCompleted } = harness();
    const first = deferred<boolean>();
    markIssueCompleted.mockReturnValueOnce(first.promise);
    owner.observeAcceptedProjection('ws', merged);
    await settle();
    const replacement = { ...merged, prUrl: 'https://github.com/org/other/pull/7' };
    owner.observeAcceptedProjection('ws', replacement);
    await settle();
    first.resolve(false);
    await settle();
    owner.observeAcceptedProjection('ws', replacement);
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

  it('allows admitted work awaiting Linear context to continue', async () => {
    const h = harness();
    const context = deferred<{ apiKey: string; linearIssueId: string } | null>();
    h.getLinearContext.mockReturnValueOnce(context.promise);
    h.owner.observeAcceptedProjection('ws', merged);
    await settle();
    clear(h);
    context.resolve({ apiKey: 'key', linearIssueId: 'issue' });
    await settle();
    expect(h.markIssueCompleted).toHaveBeenCalledExactlyOnceWith('key', 'issue');
    h.owner.observeAcceptedProjection('ws', merged);
    await settle();
    expect(h.markIssueCompleted).toHaveBeenCalledTimes(2);
  });
});
