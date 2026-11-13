// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { WorkspaceHeaderWorkspace } from './types';
import { WorkspacePrAction } from './workspace-status';
const mocks = vi.hoisted(() => ({
  pending: false,
  error: false,
  refetch: vi.fn(),
  data: undefined as { id: string; name: string; content: string }[] | undefined,
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      listQuickActions: {
        useQuery: () => ({
          data: mocks.data,
          isPending: mocks.pending,
          isError: mocks.error,
          refetch: mocks.refetch,
        }),
      },
    },
  },
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.refetch.mockReset();
});
it.each([true, false])(
  'keeps the catalog action visible with loading/retry feedback (pending=%s)',
  async (pending) => {
    mocks.pending = pending;
    mocks.error = !pending;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const run = vi.fn();
    try {
      await act(() =>
        root.render(
          <TooltipProvider>
            <WorkspacePrAction
              workspace={{ prs: [], branchName: 'feature' } as unknown as WorkspaceHeaderWorkspace}
              hasChanges
              running={false}
              isCreatingSession={false}
              handleQuickAction={run}
            />
          </TooltipProvider>
        )
      );
      const button = container.querySelector('button')!;
      expect(button.textContent).toBe(pending ? 'Loading PR action…' : 'Retry PR action');
      expect(button.disabled).toBe(pending);
      await act(() => button.click());
      expect(mocks.refetch).toHaveBeenCalledTimes(pending ? 0 : 1);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  }
);

it('shows a spinner on the PR action while a chat is being created', async () => {
  mocks.pending = false;
  mocks.error = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <TooltipProvider>
          <WorkspacePrAction
            workspace={{ prs: [], branchName: 'feature' } as unknown as WorkspaceHeaderWorkspace}
            hasChanges
            running={false}
            isCreatingSession
            handleQuickAction={vi.fn()}
          />
        </TooltipProvider>
      )
    );
    const button = container.querySelector('button')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('[data-slot=spinner]')).not.toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  ['no PR', [], {}, true],
  ['an earlier merged PR', [{ state: 'MERGED', headRefName: 'feature' }], {}, true],
  ['an earlier closed PR', [{ state: 'CLOSED', headRefName: 'feature' }], {}, true],
  ['an open PR from another branch', [{ state: 'OPEN', headRefName: 'other' }], {}, true],
  ['an open PR for this branch', [{ state: 'OPEN', headRefName: 'feature' }], {}, false],
  ['a running agent', [], { running: true }, false],
  ['no changes', [], { hasChanges: false }, false],
] as const)(
  'offers Create PR only for a changed, idle branch without its own open PR: %s',
  async (_name, prs, props, offered) => {
    mocks.pending = false;
    mocks.error = false;
    mocks.data = [{ id: 'create-pr', name: 'Create PR', content: 'Open a pull request' }];
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const run = vi.fn();
    try {
      await act(() =>
        root.render(
          <TooltipProvider>
            <WorkspacePrAction
              workspace={{ prs, branchName: 'feature' } as unknown as WorkspaceHeaderWorkspace}
              hasChanges
              running={false}
              isCreatingSession={false}
              handleQuickAction={run}
              {...props}
            />
          </TooltipProvider>
        )
      );
      const button = container.querySelector('button');
      expect(button?.textContent ?? null).toBe(offered ? 'Create PR' : null);
      await act(() => button?.click());
      expect(run.mock.calls).toEqual(offered ? [['Create PR', 'Open a pull request']] : []);
    } finally {
      await act(() => root.unmount());
      container.remove();
      mocks.data = undefined;
      vi.unstubAllGlobals();
    }
  }
);
