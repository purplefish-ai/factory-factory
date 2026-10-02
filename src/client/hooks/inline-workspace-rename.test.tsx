// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanCard, type WorkspaceWithKanban } from '@/client/features/kanban/kanban-card';
import { WorkspaceDetailHeaderSlot } from '@/client/routes/projects/workspaces/workspace-detail-header';
import type { WorkspaceHeaderProps } from '@/client/routes/projects/workspaces/workspace-detail-header/types';

const mocks = vi.hoisted(() => ({ rename: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: { listForProject: { invalidate: mocks.list }, get: { invalidate: mocks.get } },
    }),
    workspace: {
      rename: { useMutation: () => ({ mutateAsync: mocks.rename }) },
      attachPR: { useMutation: () => ({}) },
    },
  },
}));
vi.mock('@/client/components/app-header-context', () => ({
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HeaderLeftExtraSlot: () => null,
  HeaderRightSlot: () => null,
  useAppHeader: () => undefined,
}));
vi.mock('@/client/components/project-selector', () => ({ ProjectSelectorDropdown: () => null }));
vi.mock('@/client/routes/projects/workspaces/use-workspace-project-navigation', () => ({
  useWorkspaceProjectNavigation: () => ({ slug: 'project', projects: [] }),
}));
vi.mock('@/client/routes/projects/workspaces/workspace-detail-header/index', () => ({
  WorkspaceSwitcherDropdown: ({ currentWorkspaceName }: { currentWorkspaceName: string }) => (
    <span>{currentWorkspaceName}</span>
  ),
  getWorkspaceHeaderLabel: (_branch: string, name: string) => name,
  WorkspaceProviderSettings: () => null,
  WorkspacePrAction: () => null,
  WorkspaceIssueLink: () => null,
  WorkspaceCiStatus: () => null,
  WorkspaceHeaderOverflowMenu: () => null,
  AdversarialReviewButton: () => null,
  ArchiveActionButton: () => null,
  OpenInIdeAction: () => null,
  RatchetingToggle: () => null,
  ToggleRightPanelButton: () => null,
  WorkspaceBranchLink: () => null,
}));
vi.mock('@/client/features/workspace', () => ({
  RunScriptButton: () => null,
  RunScriptPortBadge: () => null,
  ArchiveWorkspaceDialog: () => null,
  RatchetToggleButton: () => null,
  WorkspaceStatusBadge: () => null,
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: () => null,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: () => null,
  DialogContent: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null,
}));

const workspace = {
  id: 'mock-a',
  projectId: 'project-a',
  name: 'Original',
  status: 'READY',
  prState: 'NONE',
  prCiStatus: 'UNKNOWN',
  mode: 'STANDARD',
  kanbanColumn: 'WAITING',
  sessionSummaries: [],
};
let container: HTMLDivElement;
let root: Root;
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function click(element: Element) {
  await act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
async function key(input: HTMLInputElement, name: string) {
  await act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));
}
async function blur(input: HTMLInputElement) {
  await act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}
async function change(input: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  mocks.rename.mockReset();
  mocks.list.mockReset();
  mocks.get.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

for (const surface of ['header', 'card'] as const) {
  describe(`${surface} inline rename`, () => {
    async function render(data = workspace) {
      await act(() =>
        root.render(
          surface === 'card' ? (
            <KanbanCard
              workspace={data as unknown as WorkspaceWithKanban}
              projectSlug={data.projectId}
              onRename={async (id, name) => {
                await mocks.rename({ id, name });
                await mocks.list({ projectId: data.projectId });
                await mocks.get({ id });
              }}
            />
          ) : (
            <WorkspaceDetailHeaderSlot
              workspace={data as unknown as WorkspaceHeaderProps['workspace']}
              workspaceId={data.id}
              availableIdes={[]}
              preferredIde="code"
              openInIde={{ mutate: vi.fn(), isPending: false }}
              archivePending={false}
              onArchiveRequest={vi.fn()}
              handleQuickAction={vi.fn()}
              running={false}
              isCreatingSession={false}
            />
          )
        )
      );
    }
    const button = () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Rename workspace"]')!;
    const input = () => container.querySelector<HTMLInputElement>('input');
    async function edit(value = 'Renamed') {
      await click(button());
      await change(input()!, value);
      return input()!;
    }

    it('submits once through repeated Enter, click and blur until cache refresh finishes', async () => {
      const request = deferred();
      const refresh = deferred();
      mocks.rename.mockReturnValue(request.promise);
      mocks.list.mockReturnValue(refresh.promise);
      await render();
      const editor = await edit('  Renamed  ');
      await act(() => {
        editor.focus();
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      await click(editor);
      await act(() => editor.focus());
      await key(editor, 'Enter');
      await blur(editor);
      expect(mocks.rename).toHaveBeenCalledTimes(1);
      expect(mocks.rename).toHaveBeenCalledWith({ id: 'mock-a', name: 'Renamed' });
      expect(editor.readOnly).toBe(true);
      expect(editor.getAttribute('aria-busy')).toBe('true');
      await act(() => request.resolve());
      await blur(editor);
      if (button()) {
        await click(button());
      }
      expect(mocks.rename).toHaveBeenCalledTimes(1);
      await act(() => refresh.resolve());
      expect(input()).toBeNull();
    });

    it('closes on failure and allows a fresh retry', async () => {
      const request = deferred();
      mocks.rename.mockReturnValueOnce(request.promise);
      await render();
      await blur(await edit());
      await act(() => request.reject(new Error('mock failure')));
      expect(input()).toBeNull();
      await blur(await edit('Retry'));
      expect(mocks.rename).toHaveBeenCalledTimes(2);
      expect(mocks.rename).toHaveBeenLastCalledWith({ id: 'mock-a', name: 'Retry' });
    });

    it('cancels synchronously before a same-turn blur', async () => {
      await render();
      const editor = await edit();
      await act(() => {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(mocks.rename).not.toHaveBeenCalled();
      expect(input()).toBeNull();
    });

    it.each(['', ' Original '])(
      'does not submit an empty or unchanged name (%s)',
      async (value) => {
        await render();
        await blur(await edit(value));
        expect(mocks.rename).not.toHaveBeenCalled();
        expect(input()).toBeNull();
      }
    );

    it('keeps a dispatched save guarded after Escape until it settles', async () => {
      const request = deferred();
      mocks.rename.mockReturnValueOnce(request.promise);
      await render();
      const editor = await edit();
      await blur(editor);
      await key(editor, 'Escape');
      if (button()) {
        await click(button());
      }
      expect(input()).toBeNull();
      expect(mocks.rename).toHaveBeenCalledTimes(1);
      await act(() => request.resolve());
      await click(button());
      expect(input()?.value).toBe('Original');
    });

    it.each(['success', 'failure'] as const)(
      'does not let a late %s overwrite a newer workspace edit',
      async (outcome) => {
        const old = deferred();
        const current = deferred();
        mocks.rename.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
        await render();
        await blur(await edit('Old request'));
        await render({ ...workspace, id: 'mock-b', projectId: 'project-b', name: 'Workspace B' });
        expect(input()).toBeNull();
        const newer = await edit('New draft');
        await act(() =>
          outcome === 'success' ? old.resolve() : old.reject(new Error('old failure'))
        );
        expect(input()).toBe(newer);
        expect(newer.value).toBe('New draft');
        if (outcome === 'success') {
          expect(mocks.list).toHaveBeenCalledWith({ projectId: 'project-a' });
          expect(mocks.get).toHaveBeenCalledWith({ id: 'mock-a' });
        }
        await blur(newer);
        expect(mocks.rename).toHaveBeenLastCalledWith({ id: 'mock-b', name: 'New draft' });
        await act(() => current.resolve());
      }
    );

    it('preserves a draft through same-workspace cache updates', async () => {
      await render();
      const editor = await edit('My draft');
      await render({ ...workspace, name: 'Snapshot update' });
      expect(input()).toBe(editor);
      expect(editor.value).toBe('My draft');
    });

    it('ignores composing Enter and can retry after cache refresh rejects', async () => {
      mocks.list.mockRejectedValueOnce(new Error('refresh failed'));
      await render();
      const editor = await edit();
      await act(() => {
        editor.focus();
        editor.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
        );
      });
      expect(mocks.rename).not.toHaveBeenCalled();
      expect(input()).toBe(editor);
      await key(editor, 'Enter');
      expect(input()).toBeNull();
      await blur(await edit('Retry'));
      expect(mocks.rename).toHaveBeenCalledTimes(2);
    });

    it('ignores a previous visit response after A/B/A navigation', async () => {
      const old = deferred();
      mocks.rename.mockReturnValueOnce(old.promise);
      await render();
      await blur(await edit('First visit'));
      await render({ ...workspace, id: 'mock-b', projectId: 'project-b' });
      await render();
      const editor = await edit('Second visit');
      await act(() => old.resolve());
      expect(input()).toBe(editor);
      expect(editor.value).toBe('Second visit');
    });

    it('abandons unsaved input when only the project changes', async () => {
      await render();
      await edit();
      await render({ ...workspace, projectId: 'project-b' });
      expect(input()).toBeNull();
      expect(mocks.rename).not.toHaveBeenCalled();
    });

    it('does not let a response from a departed mount close a returning editor', async () => {
      const old = deferred();
      mocks.rename.mockReturnValueOnce(old.promise);
      await render();
      await blur(await edit());
      await act(() => root.render(null));
      await render();
      const newer = await edit('Returning draft');
      await act(() => old.resolve());
      expect(input()).toBe(newer);
      expect(newer.value).toBe('Returning draft');
    });
  });
}
