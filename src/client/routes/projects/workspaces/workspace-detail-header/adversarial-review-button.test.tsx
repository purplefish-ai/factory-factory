// @vitest-environment jsdom

import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AdversarialReviewButton } from './adversarial-review-button';
import type { WorkspaceHeaderWorkspace } from './types';

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ session: { listSessions: { invalidate: vi.fn() } } }),
    adversarialReview: { trigger: { useMutation: () => mutation } },
  },
}));

function workspace(overrides: Partial<WorkspaceHeaderWorkspace> = {}): WorkspaceHeaderWorkspace {
  return {
    id: 'workspace-1',
    status: 'READY',
    worktreePath: '/mock/worktree',
    prUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    prState: 'OPEN',
    ratchetState: 'IDLE',
    sidebarStatus: { activityState: 'IDLE', ciState: 'NONE' },
    ...overrides,
  } as WorkspaceHeaderWorkspace;
}

let root: Root;

beforeEach(() => {
  mutation.isPending = false;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  document.body.innerHTML = '';
});

describe.each([false, true])('AdversarialReviewButton (menu=%s)', (renderAsMenuItem) => {
  function render(value: WorkspaceHeaderWorkspace) {
    const action = (
      <AdversarialReviewButton
        workspace={value}
        workspaceId={value.id}
        renderAsMenuItem={renderAsMenuItem}
      />
    );
    flushSync(() => {
      root.render(
        <TooltipProvider>
          {renderAsMenuItem ? (
            <DropdownMenu open modal={false}>
              <DropdownMenuContent>{action}</DropdownMenuContent>
            </DropdownMenu>
          ) : (
            action
          )}
        </TooltipProvider>
      );
    });
  }

  function getAction() {
    return document.querySelector<HTMLElement>(
      renderAsMenuItem ? '[role="menuitem"]' : 'button[aria-label="Start adversarial review"]'
    );
  }

  it.each(['NEW', 'PROVISIONING', 'FAILED', 'READY'] as const)(
    'hides the action without a worktree in %s state',
    (status) => {
      render(workspace({ status, worktreePath: null }));
      expect(getAction()).toBeNull();
      expect(mutation.mutate).not.toHaveBeenCalled();
    }
  );

  it('hides the action for an empty worktree path', () => {
    render(workspace({ worktreePath: '' }));
    expect(getAction()).toBeNull();
  });

  it.each(['READY', 'FAILED'] as const)('allows a worktree in %s state', (status) => {
    render(workspace({ status }));
    const action = getAction();
    expect(action).not.toBeNull();
    flushSync(() => action?.click());
    expect(mutation.mutate).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' });
  });

  it('updates eligibility when the worktree is created, removed, and replaced', () => {
    render(workspace({ status: 'PROVISIONING', worktreePath: null }));
    expect(getAction()).toBeNull();
    render(workspace());
    expect(getAction()).not.toBeNull();
    render(workspace({ worktreePath: null }));
    expect(getAction()).toBeNull();
    render(workspace({ worktreePath: '/mock/replacement' }));
    flushSync(() => getAction()?.click());
    expect(mutation.mutate).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace-1' });
  });

  it('disables the action while a review trigger is pending', () => {
    mutation.isPending = true;
    render(workspace());
    const action = getAction();
    expect(action).not.toBeNull();
    if (renderAsMenuItem) {
      expect(action?.getAttribute('aria-disabled')).toBe('true');
    } else {
      expect((action as HTMLButtonElement).disabled).toBe(true);
    }
    flushSync(() => action?.click());
    expect(mutation.mutate).not.toHaveBeenCalled();
  });

  it.each([
    { prUrl: null },
    { prNumber: null },
    { prState: 'NONE' as const },
    { prState: 'MERGED' as const },
    { prState: 'CLOSED' as const },
    { ratchetState: 'MERGED' as const },
  ])('preserves PR eligibility for %j', (overrides) => {
    render(workspace(overrides));
    expect(getAction()).toBeNull();
    expect(mutation.mutate).not.toHaveBeenCalled();
  });
});
