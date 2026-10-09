// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToggleRatchetingInput } from '@/client/hooks/use-toggle-ratcheting';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RatchetingToggle } from './ratcheting-toggle';
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
async function openMenu(
  mode: 'MAIN' | 'DEDICATED' = 'MAIN',
  enabled = false,
  pauseReason: string | null = null
) {
  await act(() =>
    root.render(
      <TooltipProvider>
        <WorkspaceHeaderOverflowMenu
          workspace={
            {
              id: 'w',
              projectId: 'p',
              name: 'Workspace',
              ratchetEnabled: enabled,
              prMonitoring: { deliveryMode: mode, pauseReason, bindingRevision: 3 },
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
    (candidate) =>
      candidate.textContent?.includes(enabled ? 'Turn off PR updates' : 'Turn on PR updates')
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

it('selects a dedicated destination while monitoring stays off and retains the main preference', async () => {
  await openMenu();
  const destination = document.querySelector<HTMLElement>(
    '[role="menuitemradio"][data-state="unchecked"]'
  )!;
  expect(destination.textContent).toContain('Dedicated conversation per PR');
  await act(() => destination.click());
  expect(mocks.mutate).toHaveBeenCalledWith({
    workspaceId: 'w',
    enabled: false,
    deliveryMode: 'DEDICATED',
    expectedBindingRevision: 3,
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('shows the current dedicated destination and preserves it when switching monitoring off', async () => {
  const item = await openMenu('DEDICATED', true);
  expect(
    document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent
  ).toContain('Dedicated conversation per PR');
  expect(document.body.textContent).not.toContain('Change PR update conversation');
  await act(() => item.click());
  expect(mocks.mutate).toHaveBeenCalledWith({
    workspaceId: 'w',
    enabled: false,
  });
});

it.each(['MAIN', 'DEDICATED'] as const)(
  'resumes paused %s updates from the mobile menu with the current revision',
  async (mode) => {
    await openMenu(mode, true, 'SESSION_FAILED');
    const resume = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent === 'Resume PR updates'
    )!;
    expect(resume).toBeDefined();
    await act(() => resume.click());
    expect(mocks.mutate).toHaveBeenCalledWith({
      workspaceId: 'w',
      enabled: true,
      resume: true,
      deliveryMode: mode,
      expectedBindingRevision: 3,
    });
  }
);

it('enables monitoring from a stale mobile destination without overwriting the saved mode', async () => {
  const toggle = await openMenu('MAIN', false);
  await act(() => toggle.click());
  expect(mocks.mutate).toHaveBeenCalledWith({ workspaceId: 'w', enabled: true });
});
it.each(['MAIN', 'DEDICATED'] as const)(
  'enables monitoring from a stale desktop %s destination without changing it',
  async (deliveryMode) => {
    await act(() =>
      root.render(
        <TooltipProvider>
          <RatchetingToggle
            workspaceId="w"
            workspace={
              {
                id: 'w',
                projectId: 'p',
                ratchetEnabled: false,
                ratchetState: 'IDLE',
                prMonitoring: { deliveryMode, bindingRevision: 3 },
              } as WorkspaceHeaderWorkspace
            }
          />
        </TooltipProvider>
      )
    );
    await act(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Enable PR updates"]')!.click()
    );
    expect(mocks.mutate).toHaveBeenCalledWith({ workspaceId: 'w', enabled: true });
  }
);
