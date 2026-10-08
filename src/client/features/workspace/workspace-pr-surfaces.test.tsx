// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceItemContent } from '@/client/components/workspace-item-content';
import { KanbanCard } from '@/client/features/kanban';
import { useProjectSnapshotSync } from '@/client/hooks/use-project-snapshot-sync';
import {
  type ProjectWorkspace,
  projectSnapshotToWorkspace,
} from '@/client/lib/snapshot-to-workspace';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { UseWebSocketTransportOptions } from '@/hooks/use-websocket-transport';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { makeWorkspaceSnapshotEntry } from '@/test-utils/workspace-snapshot';
import { ConnectedWorkspacePrMenu } from './workspace-pr-menu';

const actions = vi.hoisted(() => ({
  add: vi.fn().mockResolvedValue({ success: true }),
  remove: vi.fn().mockResolvedValue(true),
  review: vi.fn(),
}));
vi.mock('./use-workspace-pr-actions', () => ({
  useWorkspacePrActions: () => ({ ...actions, pending: false }),
}));
const snapshot = vi.hoisted(() => ({
  utils: null as unknown,
  onMessage: undefined as UseWebSocketTransportOptions['onMessage'],
}));
vi.mock('@/client/lib/trpc', () => ({ trpc: { useUtils: () => snapshot.utils } }));
vi.mock('@/hooks/use-websocket-transport', () => ({
  useWebSocketTransport: (options: UseWebSocketTransportOptions) => {
    snapshot.onMessage = options.onMessage;
    return { connected: true, send: vi.fn(), reconnect: vi.fn() };
  },
}));
const baseWorkspace = projectSnapshotToWorkspace(
  makeWorkspaceSnapshotEntry({ name: 'Workspace', status: 'READY' })
);
const pr: WorkspacePullRequest = {
  id: 'attached-42',
  url: 'https://github.com/team/repo/pull/42',
  number: 42,
  title: 'Workspace PR',
  headRefName: 'feat/pr',
  baseRefName: 'main',
  state: 'OPEN',
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
  ratchet: {
    lastCheckedAt: null,
    dispatchOutcome: null,
    dispatchRetryCount: 0,
    dispatchStalled: false,
  },
};
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(() => root?.unmount());
  document.body.innerHTML = '';
});
async function render(node: ReactNode, onParentClick?: () => void) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() =>
    root.render(
      <MemoryRouter>
        <TooltipProvider>
          <a
            href="/workspace"
            onClick={(event) => {
              event.preventDefault();
              onParentClick?.();
            }}
          >
            {node}
          </a>
        </TooltipProvider>
      </MemoryRouter>
    )
  );
}
async function key(element: Element, key: string) {
  await act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
}
function item(label: string) {
  const element = [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === label
  );
  if (!element) {
    throw new Error(`Missing menu item ${label}`);
  }
  return element;
}
async function openMenu() {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="PRs (1)"]')!;
  trigger.focus();
  await key(trigger, 'Enter');
}
async function openPR() {
  await openMenu();
  const row = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
    item.textContent?.includes('Workspace PR')
  )!;
  await key(row, 'ArrowRight');
  await vi.waitFor(() => expect(item('Remove from workspace')).toBeTruthy());
}
describe('workspace PR actions across surfaces', () => {
  for (const surface of ['card', 'sidebar'] as const) {
    async function renderSurface() {
      const workspace = { ...baseWorkspace, prs: [pr], worktreePath: '/tmp/worktree' };
      await render(
        surface === 'card' ? (
          <KanbanCard workspace={workspace} projectSlug="project" />
        ) : (
          <WorkspaceItemContent workspace={workspace} />
        )
      );
    }
    it(`${surface} exposes an add dialog and targets the attached PR for review`, async () => {
      await renderSurface();
      await openPR();
      await key(item('Run review'), 'Enter');
      expect(actions.review).toHaveBeenCalledWith('attached-42');
      await openMenu();
      await key(item('Add PR'), 'Enter');
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Add PR');
      expect(document.querySelector('input[aria-label="GitHub PR URL"]')).not.toBeNull();
    });
    it(`${surface} confirms removal of the selected PR`, async () => {
      await renderSurface();
      await openPR();
      await key(item('Remove from workspace'), 'Enter');
      const dialog = document.querySelector('[role="alertdialog"]')!;
      expect(dialog.textContent).toContain('Remove PR from workspace?');
      const confirm = [...dialog.querySelectorAll('button')].find(
        (button) => button.textContent === 'Remove'
      )!;
      await act(() => confirm.click());
      expect(actions.remove).toHaveBeenCalledWith('attached-42');
    });
  }
  it('does not select the containing workspace when cancelling the add dialog', async () => {
    const onParentClick = vi.fn();
    await render(<ConnectedWorkspacePrMenu workspaceId="ws-1" prs={[pr]} />, onParentClick);
    await openMenu();
    await key(item('Add PR'), 'Enter');
    const dialog = document.querySelector('[role="dialog"]')!;
    const cancel = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel'
    )!;
    await act(() => cancel.click());
    expect(onParentClick).not.toHaveBeenCalled();
  });
  it('enables sidebar review after a ready snapshot refetches the actual worktree path', async () => {
    let cache: { workspaces: ProjectWorkspace[]; reviewCount: number } = {
      workspaces: [
        {
          ...baseWorkspace,
          status: 'NEW',
          worktreePath: null,
          prs: [pr],
        },
      ],
      reviewCount: 0,
    };
    function LiveSidebar() {
      useProjectSnapshotSync('proj-1');
      return <WorkspaceItemContent workspace={cache.workspaces[0]!} />;
    }
    const rerender = () =>
      root.render(
        <MemoryRouter>
          <TooltipProvider>
            <LiveSidebar />
          </TooltipProvider>
        </MemoryRouter>
      );
    let completeRefetch!: () => void;
    snapshot.utils = {
      workspace: {
        listForProject: {
          getData: () => cache,
          setData: (_input: unknown, updater: (previous: typeof cache) => typeof cache) => {
            cache = updater(cache);
            rerender();
          },
          invalidate: () =>
            new Promise<void>((resolve) => {
              completeRefetch = () => {
                cache = {
                  ...cache,
                  workspaces: cache.workspaces.map((workspace) => ({
                    ...workspace,
                    worktreePath: '/actual/provisioned/worktree',
                  })),
                };
                rerender();
                resolve();
              };
            }),
        },
        get: { setData: vi.fn() },
      },
    };
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(rerender);
    await openPR();
    expect(document.body.textContent).not.toContain('Run review');
    await key(document.querySelector('[role="menu"]')!, 'Escape');
    await act(() =>
      snapshot.onMessage?.({
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: makeWorkspaceSnapshotEntry({ status: 'READY', prs: [pr] }),
      })
    );
    expect(cache.workspaces[0]).toMatchObject({ status: 'READY', worktreePath: null });
    expect(completeRefetch).toBeTypeOf('function');
    await act(() => completeRefetch());
    await openPR();
    await key(item('Run review'), 'Enter');
    expect(actions.review).toHaveBeenCalledWith('attached-42');
  });
  it('keeps PR management available before the worktree is ready', async () => {
    await render(<ConnectedWorkspacePrMenu workspaceId="ws-1" prs={[pr]} reviewEnabled={false} />);
    await openPR();
    expect(document.body.textContent).not.toContain('Run review');
    expect(item('Remove from workspace').getAttribute('aria-disabled')).not.toBe('true');
    await key(document.querySelector('[role="menu"]')!, 'Escape');
  });
});
