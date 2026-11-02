// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import { TooltipProvider } from '@/components/ui/tooltip';
import { makeWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';
import { ConnectedWorkspacePrMenu } from './workspace-pr-menu';

const review = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: { get: { invalidate: vi.fn() }, listForProject: { invalidate: vi.fn() } },
      session: { listSessions: { invalidate: vi.fn() } },
    }),
    workspace: {
      attachPR: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
      detachPR: { useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }) },
    },
    adversarialReview: { trigger: { useMutation: () => ({ ...review, isPending: false }) } },
  },
}));
vi.mock('@/client/hooks/use-toggle-ratcheting', () => ({ useToggleRatcheting: vi.fn() }));

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  review.mutate.mockReset();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  document.body.innerHTML = '';
});

function scalarSnapshot(number: number) {
  return makeWorkspaceSnapshotEntry({
    prUrl: `https://github.com/org/repo/pull/${number}`,
    prNumber: number,
    prState: 'OPEN',
    prCiStatus: 'SUCCESS',
  });
}
async function key(element: Element, value: string) {
  await act(() =>
    element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))
  );
}

it.each(['plain', 'suffixed', 'persisted'] as const)(
  'routes a %s snapshot PR through the connected menu with a safe review identity',
  async (identity) => {
    let workspace = projectSnapshotToWorkspace(scalarSnapshot(42));
    const number = identity === 'suffixed' ? 43 : 42;
    if (identity === 'suffixed') {
      workspace = projectSnapshotToWorkspace(scalarSnapshot(number), workspace);
    }
    if (identity === 'persisted') {
      workspace = { ...workspace, prs: workspace.prs.map((pr) => ({ ...pr, id: 'persisted-pr' })) };
    }
    const expectedId =
      identity === 'persisted'
        ? 'persisted-pr'
        : identity === 'plain'
          ? 'legacy-pr-ws-1'
          : 'legacy-pr-ws-1-https://github.com/org/repo/pull/43';
    expect(workspace.prs.find((pr) => pr.number === number)?.id).toBe(expectedId);
    await act(() =>
      root.render(
        <TooltipProvider>
          <ConnectedWorkspacePrMenu workspaceId={workspace.id} prs={workspace.prs} />
        </TooltipProvider>
      )
    );
    const trigger = document.querySelector('button')!;
    trigger.focus();
    await key(trigger, 'Enter');
    const row = [...document.querySelectorAll('[role="menuitem"]')].find((element) =>
      element.textContent?.startsWith(`#${number} ·`)
    )!;
    expect(row).toBeTruthy();
    await key(row, 'ArrowRight');
    const reviewItem = () =>
      [...document.querySelectorAll('[role="menuitem"]')].find(
        (element) => element.textContent === 'Run review'
      );
    await vi.waitFor(() => expect(reviewItem()).toBeTruthy());
    await key(reviewItem()!, 'Enter');
    expect(review.mutate).toHaveBeenCalledExactlyOnceWith({
      workspaceId: workspace.id,
      ...(identity === 'persisted' ? { prId: expectedId } : {}),
    });
  }
);
