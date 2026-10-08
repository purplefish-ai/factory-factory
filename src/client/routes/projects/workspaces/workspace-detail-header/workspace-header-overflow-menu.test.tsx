// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToggleRatchetingInput } from '@/client/hooks/use-toggle-ratcheting';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { WorkspaceHeaderWorkspace } from './types';
import { WorkspaceHeaderOverflowMenu } from './workspace-header-overflow-menu';

type SelectionResult = { status: 'recipient_required'; bindingRevision: number; candidates: [] };
const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  error: vi.fn(),
  invalidate: vi.fn(),
  options: null as null | {
    onSuccess(result: SelectionResult, input: ToggleRatchetingInput): void;
    onError(error: Error): void;
  },
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        get: { invalidate: mocks.invalidate },
        listForProject: { invalidate: mocks.invalidate },
      },
    }),
    workspace: {
      toggleRatcheting: {
        useMutation: (options: NonNullable<typeof mocks.options>) => {
          mocks.options = options;
          return { mutate: mocks.mutate, mutateAsync: mocks.mutate, isPending: false };
        },
      },
      rename: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
    },
  },
}));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));
vi.mock('./workspace-provider-settings', () => ({ WorkspaceProviderSettings: () => null }));
vi.mock('./adversarial-review-button', () => ({ AdversarialReviewButton: () => null }));
vi.mock('./archive-action-button', () => ({ ArchiveActionButton: () => null }));
vi.mock('./open-dev-app-action', () => ({ OpenDevAppAction: () => null }));
vi.mock('./open-in-ide-action', () => ({ OpenInIdeAction: () => null }));
vi.mock('./workspace-branch-link', () => ({ WorkspaceBranchLink: () => null }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  mocks.mutate.mockReset();
  mocks.error.mockReset();
  mocks.options = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
async function openMenu() {
  await act(() =>
    root.render(
      <TooltipProvider>
        <WorkspaceHeaderOverflowMenu
          workspace={
            {
              id: 'w',
              projectId: 'p',
              name: 'Workspace',
              ratchetEnabled: false,
            } as WorkspaceHeaderWorkspace
          }
          workspaceId="w"
          availableIdes={[]}
          preferredIde="code"
          openInIde={{ mutate: vi.fn(), isPending: false }}
          archivePending={false}
          onArchiveRequest={vi.fn()}
        />
      </TooltipProvider>
    )
  );
  await act(() =>
    document
      .querySelector('[aria-label="More actions"]')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }))
  );
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (candidate) => candidate.textContent?.includes('Turn on PR updates')
  );
  expect(item).toBeDefined();
  return item!;
}
async function requestRecipient() {
  const item = await openMenu();
  await act(() => item.click());
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(() =>
    mocks.options!.onSuccess(
      { status: 'recipient_required', bindingRevision: 1, candidates: [] },
      { workspaceId: 'w', enabled: true }
    )
  );
}
it('keeps the recipient dialog alive after selecting and closing the overflow menu', async () => {
  await requestRecipient();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Choose the main conversation'
  );
});
it('clears an exhausted recipient selection when the binding mutation fails', async () => {
  await requestRecipient();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(() => mocks.options!.onError(new Error('Binding changed')));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Choose the main conversation');
});
