// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { WorkspaceHeaderWorkspace } from './types';
import { WorkspaceHeaderOverflowMenu } from './workspace-header-overflow-menu';

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: { get: { invalidate: vi.fn() }, listForProject: { invalidate: vi.fn() } },
    }),
    workspace: { rename: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) } },
  },
}));
vi.mock('./workspace-provider-settings', () => ({ WorkspaceProviderSettings: () => null }));
vi.mock('./workspace-branch-link', () => ({ WorkspaceBranchLink: () => null }));
vi.mock('./open-dev-app-action', () => ({ OpenDevAppAction: () => null }));
vi.mock('./open-in-ide-action', () => ({
  OpenInIdeAction: () => (
    <div role="menuitem" tabIndex={-1}>
      Open in IDE
    </div>
  ),
}));
vi.mock('./archive-action-button', () => ({ ArchiveActionButton: () => null }));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());
it.each(['READY', 'ARCHIVING', 'ARCHIVED'] as const)(
  'offers overflow rename only for a live workspace: %s',
  async (status) => {
    const workspace: Partial<WorkspaceHeaderWorkspace> = {
      id: 'w',
      projectId: 'p',
      name: 'Workspace',
      status,
      description: null,
      initialPrompt: null,
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <TooltipProvider>
            <WorkspaceHeaderOverflowMenu
              workspace={workspace as WorkspaceHeaderWorkspace}
              workspaceId="w"
              availableIdes={[]}
              preferredIde="vscode"
              openInIde={{ mutate: vi.fn(), isPending: false }}
              archivePending={false}
              onArchiveRequest={vi.fn()}
              isArchived={status !== 'READY'}
            />
          </TooltipProvider>
        )
      );
      const trigger = container.querySelector('button[aria-label="More actions"]');
      expect(trigger).not.toBeNull();
      await act(() => {
        trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      const items = [...document.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent
      );
      expect(items).toContain('View details');
      expect(items).toContain('Provider settings');
      expect(items.includes('Rename workspace')).toBe(status === 'READY');
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  }
);

it('closes an active rename dialog when the workspace becomes archived', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (isArchived: boolean) => (
    <TooltipProvider>
      <WorkspaceHeaderOverflowMenu
        workspace={
          {
            id: 'w',
            projectId: 'p',
            name: 'Workspace',
            status: isArchived ? 'ARCHIVED' : 'READY',
          } as WorkspaceHeaderWorkspace
        }
        workspaceId="w"
        availableIdes={[]}
        preferredIde="vscode"
        openInIde={{ mutate: vi.fn(), isPending: false }}
        archivePending={false}
        onArchiveRequest={vi.fn()}
        isArchived={isArchived}
      />
    </TooltipProvider>
  );
  try {
    await act(() => root.render(render(false)));
    await act(() => {
      container
        .querySelector('button[aria-label="More actions"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Rename workspace'
    );
    await act(() => rename!.click());
    expect(document.querySelector('input[placeholder="Workspace name"]')).not.toBeNull();
    await act(() => root.render(render(true)));
    expect(document.querySelector('input[placeholder="Workspace name"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it('leaves out controls the header shows inline, and keeps the rest', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const workspace = { id: 'w', projectId: 'p', name: 'Workspace', status: 'READY' };
  try {
    await act(() =>
      root.render(
        <TooltipProvider>
          <header>
            <div data-header-inline="ide" data-testid="ide" />
            <div data-header-inline="create-pr" data-testid="create-pr" />
            <WorkspaceHeaderOverflowMenu
              workspace={workspace as WorkspaceHeaderWorkspace}
              workspaceId="w"
              availableIdes={[]}
              preferredIde="vscode"
              openInIde={{ mutate: vi.fn(), isPending: false }}
              archivePending={false}
              onArchiveRequest={vi.fn()}
              isArchived={false}
              statusContent={(isInline) => (
                <>
                  {!isInline('create-pr') && (
                    <div role="menuitem" tabIndex={-1}>
                      Create PR
                    </div>
                  )}
                  {!isInline('issue') && (
                    <div role="menuitem" tabIndex={-1}>
                      #12
                    </div>
                  )}
                </>
              )}
            />
          </header>
        </TooltipProvider>
      )
    );
    // jsdom has no layout: mark the IDE and Create PR wrappers as rendered.
    for (const id of ['ide', 'create-pr']) {
      const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      element.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
    }
    await act(() => {
      container
        .querySelector('button[aria-label="More actions"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const items = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent
    );
    expect(items).not.toContain('Open in IDE');
    expect(items).not.toContain('Create PR');
    expect(items).toContain('#12');
    expect(items).toContain('Provider settings');
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
