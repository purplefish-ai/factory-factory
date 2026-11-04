// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToggleRatchetingInput } from '@/client/hooks/use-toggle-ratcheting';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { WorkspaceHeaderWorkspace } from './types';
import { WorkspacePrChip } from './workspace-pr-chip';

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
    adversarialReview: { trigger: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
    workspace: {
      toggleRatcheting: {
        useMutation: (options: NonNullable<typeof mocks.options>) => {
          mocks.options = options;
          return { mutate: mocks.mutate, mutateAsync: mocks.mutate, isPending: false };
        },
      },
      attachPR: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
      detachPR: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
    },
  },
}));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  // The chip's tooltip opens when focus returns to it after the menu closes.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {
        // jsdom does no layout.
      }
      unobserve() {
        // jsdom does no layout.
      }
      disconnect() {
        // jsdom does no layout.
      }
    }
  );
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
  vi.unstubAllGlobals();
});
async function renderToggle(overrides: Partial<WorkspaceHeaderWorkspace> = {}) {
  const workspace: Partial<WorkspaceHeaderWorkspace> = {
    id: 'w',
    projectId: 'p',
    name: 'Workspace',
    prs: [],
    status: 'READY',
    ratchetState: 'IDLE',
    ratchetEnabled: false,
    prMonitoring: {
      deliveryMode: 'MAIN',
      enabled: false,
      pauseReason: null,
      bindingRevision: 3,
      recipientSessionId: null,
      pendingEventCount: 0,
    },
    ...overrides,
  };
  await act(() =>
    root.render(
      <TooltipProvider>
        <WorkspacePrChip workspace={workspace as WorkspaceHeaderWorkspace} workspaceId="w" />
      </TooltipProvider>
    )
  );
  const trigger = document.querySelector('[aria-label^="Pull requests and updates"]');
  expect(trigger).not.toBeNull();
  await act(() =>
    trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
}
async function openMenu(
  mode: 'MAIN' | 'DEDICATED' = 'MAIN',
  enabled = false,
  pauseReason: string | null = null
) {
  await renderToggle({
    ratchetEnabled: enabled,
    prMonitoring: {
      deliveryMode: mode,
      enabled,
      pauseReason,
      bindingRevision: 3,
      recipientSessionId: null,
      pendingEventCount: 0,
    },
  });
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
it('keeps the recipient dialog alive after selecting and closing the PR menu', async () => {
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
  'resumes paused %s updates from the combined menu with the current revision',
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

it('enables monitoring from a stale destination without overwriting the saved mode', async () => {
  const toggle = await openMenu('MAIN', false);
  await act(() => toggle.click());
  expect(mocks.mutate).toHaveBeenCalledWith({ workspaceId: 'w', enabled: true });
});
it('opens one combined menu without changing monitoring and keeps Add PR usable after closing', async () => {
  await openMenu();
  expect(container.querySelectorAll('button')).toHaveLength(1);
  expect(mocks.mutate).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('No PRs yet');
  const add = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === 'Add PR'
  )!;
  expect(add).toBeDefined();
  await act(() => add.click());
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Add PR');
  expect(
    document.querySelector('input[placeholder="https://github.com/owner/repo/pull/123"]')
  ).not.toBeNull();
});

it.each(['ARCHIVED', 'ARCHIVING'] as const)(
  'keeps %s PR links accessible without edit controls',
  async (status) => {
    await renderToggle({
      status,
      prs: [
        {
          id: 'pr-42',
          url: 'https://github.com/team/repository/pull/42',
          number: 42,
          title: 'Simplify workspace PR controls',
          headRefName: 'feature/pr-menu',
          baseRefName: 'main',
          state: 'OPEN',
          reviewState: null,
          ciStatus: 'SUCCESS',
          hasMergeConflict: false,
          syncedAt: null,
        },
      ],
    });
    expect(document.body.textContent).not.toContain('Add PR');
    expect(document.body.textContent).not.toContain('Turn on PR updates');
    const row = document.querySelector('[role="menuitem"]')!;
    await act(() =>
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    );
    await vi.waitFor(() =>
      expect(document.querySelector('a')?.href).toBe('https://github.com/team/repository/pull/42')
    );
    expect(document.body.textContent).not.toContain('Run review');
    expect(document.body.textContent).not.toContain('Remove from workspace');
  }
);

it.each([
  { enabled: false, state: 'CI_RUNNING', label: 'Pull requests and updates: no PR, updates off' },
  {
    enabled: true,
    state: 'IDLE',
    label: 'Pull requests and updates: no PR, updates on (Watching)',
  },
  {
    enabled: true,
    state: 'CI_RUNNING',
    label: 'Pull requests and updates: no PR, updates on (CI in progress)',
  },
  {
    enabled: true,
    state: 'REVIEW_PENDING',
    label: 'Pull requests and updates: no PR, updates on (Addressing reviews)',
  },
] as const)(
  'includes monitoring state in the accessible name: $label',
  async ({ enabled, state, label }) => {
    await renderToggle({ ratchetEnabled: enabled, ratchetState: state });
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(label);
  }
);

const pr = (overrides: Partial<WorkspaceHeaderWorkspace['prs'][number]> = {}) => ({
  id: 'pr-42',
  url: 'https://github.com/team/repository/pull/42',
  number: 42,
  title: 'Simplify workspace PR controls',
  headRefName: 'feature/pr-menu',
  baseRefName: 'main',
  state: 'OPEN' as const,
  reviewState: null,
  ciStatus: 'SUCCESS' as const,
  hasMergeConflict: false,
  syncedAt: null,
  ...overrides,
});

it.each([
  { facts: {}, text: 'CI Passing', tone: 'success' },
  { facts: { ciStatus: 'PENDING' as const }, text: 'CI Running', tone: 'waiting' },
  { facts: { ciStatus: 'FAILURE' as const }, text: 'CI Failing', tone: 'danger' },
  { facts: { state: 'CHANGES_REQUESTED' as const }, text: 'Changes requested', tone: 'danger' },
  { facts: { state: 'MERGED' as const }, text: 'Merged', tone: 'merged' },
  { facts: { hasMergeConflict: true }, text: 'Conflicts', tone: 'attention' },
])('shows the PR number with its $text state in the shared tone', async ({ facts, text, tone }) => {
  await renderToggle({ prs: [pr(facts)] });
  const trigger = container.querySelector('button')!;
  expect(trigger.getAttribute('aria-label')).toBe(
    `Pull requests and updates: #42 ${text}, updates off`
  );
  expect(trigger.textContent).toContain('#42');
  const chip = [...trigger.querySelectorAll<HTMLElement>('[data-status-tone]')].find(
    (element) => element.textContent === text
  );
  expect(chip?.dataset.statusTone).toBe(tone);
});

it('counts the other PRs next to the selected one', async () => {
  await renderToggle({
    prs: [pr(), pr({ id: 'pr-43', number: 43, state: 'CLOSED' })],
  });
  const trigger = container.querySelector('button')!;
  expect(trigger.getAttribute('aria-label')).toBe(
    'Pull requests and updates: #42 CI Passing and 1 more, updates off'
  );
  expect(trigger.textContent).toContain('+1');
});
