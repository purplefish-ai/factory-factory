// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { useWorkspacePrActions } from './use-workspace-pr-actions';

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  invalidate: vi.fn(),
  status: 'already_active',
  mutate: vi.fn(),
  discard: vi.fn(),
  reviewPending: false,
}));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: vi.fn() } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: { get: { invalidate: vi.fn() }, listForProject: { invalidate: vi.fn() } },
      session: { listSessions: { invalidate: mocks.invalidate } },
    }),
    workspace: {
      attachPR: { useMutation: () => ({ isPending: false }) },
      detachPR: { useMutation: () => ({ isPending: false }) },
      discardBlockedPRDeliveries: {
        useMutation: () => ({ isPending: false, mutateAsync: mocks.discard }),
      },
    },
    adversarialReview: {
      trigger: {
        useMutation: (options: { onSuccess: (result: { status: string }) => void }) => ({
          isPending: mocks.reviewPending,
          mutate: (input: unknown) => {
            mocks.mutate(input);
            options.onSuccess({ status: mocks.status });
          },
        }),
      },
    },
  },
}));
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  mocks.reviewPending = false;
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
});
function ReviewButton() {
  const actions = useWorkspacePrActions('workspace-1', 'project-1');
  return <button onClick={() => actions.review('pr-42')}>Review</button>;
}
it.each([
  ['already_active', 'Adversarial review is already running'],
  ['started', 'Adversarial review started'],
])('reports the %s review result and refreshes sessions', async (status, message) => {
  mocks.status = status;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<ReviewButton />));
  await act(() => host.querySelector('button')!.click());
  expect(mocks.mutate).toHaveBeenCalledWith({ workspaceId: 'workspace-1', prId: 'pr-42' });
  expect(mocks.success).toHaveBeenCalledWith(message);
  expect(mocks.invalidate).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
});

function DiscardButton({ results }: { results: boolean[] }) {
  const actions = useWorkspacePrActions('workspace-1', 'project-1');
  return (
    <button
      onClick={() => {
        void actions.discardBlocked().then((result) => results.push(result));
      }}
    >
      Discard
    </button>
  );
}
it('reports whether discarding blocked PR deliveries succeeded', async () => {
  const results: boolean[] = [];
  mocks.discard.mockResolvedValueOnce({ discarded: 1 }).mockRejectedValueOnce(new Error('denied'));
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<DiscardButton results={results} />));
  await act(async () => host.querySelector('button')!.click());
  await act(async () => host.querySelector('button')!.click());
  await vi.waitFor(() => expect(results).toEqual([true, false]));
  expect(mocks.discard.mock.calls).toEqual([
    [{ workspaceId: 'workspace-1' }],
    [{ workspaceId: 'workspace-1' }],
  ]);
});

function ReviewState({ prs }: { prs: WorkspacePullRequest[] }) {
  const actions = useWorkspacePrActions('workspace-1', 'project-1', prs);
  return (
    <>
      <button onClick={() => actions.review('legacy-2')}>Review</button>
      <output>{prs.filter(({ id }) => actions.isReviewing(id)).map(({ id }) => id)}</output>
    </>
  );
}
it('marks only the PR whose review is in flight as reviewing, legacy PRs included', async () => {
  // Legacy PRs send no prId, so the request alone cannot say which row it is for.
  const pr = (id: string): WorkspacePullRequest => ({
    id,
    identitySource: 'legacy-snapshot',
    url: `https://github.com/team/repo/pull/${id}`,
    number: null,
    title: null,
    headRefName: null,
    baseRefName: null,
    state: 'OPEN',
    reviewState: null,
    ciStatus: 'SUCCESS',
    hasMergeConflict: false,
    syncedAt: null,
  });
  const prs = [pr('legacy-1'), pr('legacy-2')];
  mocks.reviewPending = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<ReviewState prs={prs} />));
  expect(host.querySelector('output')?.textContent).toBe('');
  await act(() => host.querySelector('button')!.click());
  expect(mocks.mutate).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
  expect(host.querySelector('output')?.textContent).toBe('legacy-2');
});
