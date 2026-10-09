// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';

vi.mock('./use-workspace-pr-actions', () => ({
  useWorkspacePrActions: () => ({ pending: false, add: vi.fn(), remove: vi.fn(), review: vi.fn() }),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspacePrMenu } from './workspace-pr-menu';

const makePR = (
  id: string,
  state: WorkspacePullRequest['state'] = 'OPEN'
): WorkspacePullRequest => ({
  id,
  url: `https://github.com/${id}/repo/pull/42`,
  number: 42,
  title: `Title ${id}`,
  headRefName: id,
  baseRefName: 'main',
  state,
  reviewState: null,
  ciStatus: 'SUCCESS',
  hasMergeConflict: false,
  syncedAt: null,
});
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await act(() => root?.unmount());
  document.body.innerHTML = '';
});
async function render(node: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
}
async function key(element: Element, key: string) {
  await act(() => element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
}
function item(label: string) {
  const result = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (element) => element.textContent === label
  );
  if (!result) {
    throw new Error(`Missing menu item ${label}`);
  }
  return result;
}
async function open() {
  const trigger = document.querySelector('button')!;
  trigger.focus();
  await key(trigger, 'Enter');
}
describe('WorkspacePrMenu', () => {
  it('shows terminal status without nested interactive controls', async () => {
    await render(<WorkspacePrMenu prs={[makePR('a', 'MERGED')]} />);
    await open();
    const row = document.querySelector('[role="menuitem"]')!;
    expect(row.textContent).toContain('Merged');
    expect(row.querySelector('button, a, [tabindex]')).toBeNull();
  });

  it('exposes one empty-state add action with keyboard navigation', async () => {
    const onAdd = vi.fn();
    await render(<WorkspacePrMenu prs={[]} onAdd={onAdd} />);
    await open();
    expect(document.body.textContent).toContain('No PRs yet');
    const add = item('Add PR');
    await key(add, 'Enter');
    expect(onAdd).toHaveBeenCalledOnce();
  });
  it('uses the PR number for a single attachment', async () => {
    await render(<WorkspacePrMenu prs={[makePR('a')]} />);
    expect(document.querySelector('button')?.textContent).toContain('#42');
  });
  it('targets the chosen PR even when numbers match across repositories', async () => {
    const onReview = vi.fn();
    await render(
      <WorkspacePrMenu prs={[makePR('a'), makePR('b')]} onReview={onReview} onRemove={vi.fn()} />
    );
    await open();
    const row = Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) =>
      element.textContent?.includes('Title b')
    )!;
    await key(row, 'ArrowRight');
    await vi.waitFor(() => expect(item('Run review')).toBeTruthy());
    expect(document.querySelector('a')?.href).toBe(makePR('b').url);
    await key(item('Run review'), 'Enter');
    expect(onReview).toHaveBeenCalledWith('b');
  });
  it.each(['MERGED', 'CLOSED', 'NONE'] as const)(
    'disables review for %s without disabling removal',
    async (state) => {
      await render(
        <WorkspacePrMenu
          prs={[makePR('a', state)]}
          onReview={vi.fn()}
          onRemove={vi.fn()}
          pending={false}
        />
      );
      await open();
      const row = Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) =>
        element.textContent?.includes('Title a')
      )!;
      await key(row, 'ArrowRight');
      await vi.waitFor(() => expect(item('Run review').getAttribute('aria-disabled')).toBe('true'));
      expect(item('Remove from workspace').getAttribute('aria-disabled')).not.toBe('true');
    }
  );
  it('disables review and removal for an open PR while a mutation is pending', async () => {
    await render(
      <WorkspacePrMenu prs={[makePR('a')]} onReview={vi.fn()} onRemove={vi.fn()} pending />
    );
    await open();
    const row = document.querySelector('[role="menuitem"]')!;
    await key(row, 'ArrowRight');
    await vi.waitFor(() => expect(item('Run review').getAttribute('aria-disabled')).toBe('true'));
    expect(item('Remove from workspace').getAttribute('aria-disabled')).toBe('true');
  });
});

it('shows checked destination, description and disables controls while changing mode', async () => {
  const onDeliveryMode = vi.fn();
  await render(
    <WorkspacePrMenu
      prs={[]}
      monitoring={{
        enabled: true,
        deliveryMode: 'DEDICATED',
        pending: true,
        onToggle: vi.fn(),
        onDeliveryMode,
        onChangeRecipient: vi.fn(),
      }}
    />
  );
  await open();
  const selected = document.querySelector('[role="menuitemradio"][aria-checked="true"]')!;
  expect(selected.textContent).toContain('Dedicated conversation per PR');
  expect(selected.getAttribute('aria-disabled')).toBe('true');
  expect(document.body.textContent).toContain('reuses it for that PR');
  expect(document.body.textContent).not.toContain('Change PR update conversation');
  await key(selected, 'Enter');
  expect(onDeliveryMode).not.toHaveBeenCalled();
});

it.each(['MAIN', 'DEDICATED'] as const)(
  'resumes recoverably paused %s monitoring',
  async (deliveryMode) => {
    const onResume = vi.fn();
    await render(
      <WorkspacePrMenu
        prs={[]}
        monitoring={{
          enabled: true,
          deliveryMode,
          pauseReason: 'USER_STOPPED',
          pending: false,
          onToggle: vi.fn(),
          onDeliveryMode: vi.fn(),
          onChangeRecipient: vi.fn(),
          onResume,
        }}
      />
    );
    await open();
    await key(item('Resume PR updates'), 'Enter');
    expect(onResume).toHaveBeenCalledOnce();
  }
);
it.each(['BINDING_CHANGED', 'UNKNOWN_PAUSE', null])(
  'does not offer resume for unsupported pause %s',
  async (pauseReason) => {
    await render(
      <WorkspacePrMenu
        prs={[]}
        monitoring={{
          enabled: true,
          deliveryMode: 'DEDICATED',
          pauseReason,
          pending: false,
          onToggle: vi.fn(),
          onDeliveryMode: vi.fn(),
          onChangeRecipient: vi.fn(),
          onResume: vi.fn(),
        }}
      />
    );
    await open();
    expect(document.body.textContent).not.toContain('Resume PR updates');
  }
);
it('disables resume during a mutation and hides it when monitoring is off', async () => {
  const onResume = vi.fn();
  const monitoring = {
    enabled: true,
    deliveryMode: 'MAIN' as const,
    pauseReason: 'RECEIPT_UNAVAILABLE',
    pending: true,
    onToggle: vi.fn(),
    onDeliveryMode: vi.fn(),
    onChangeRecipient: vi.fn(),
    onResume,
  };
  await render(<WorkspacePrMenu prs={[]} monitoring={monitoring} />);
  await open();
  expect(item('Resume PR updates').getAttribute('aria-disabled')).toBe('true');
  await key(item('Resume PR updates'), 'Enter');
  expect(onResume).not.toHaveBeenCalled();
  await act(() =>
    root.render(
      <TooltipProvider>
        <WorkspacePrMenu prs={[]} monitoring={{ ...monitoring, enabled: false }} />
      </TooltipProvider>
    )
  );
  expect(document.body.textContent).not.toContain('Resume PR updates');
});
