// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectHeaderNavigation } from '@/client/components/project-header';
import { ReviewDashboard } from './review-dashboard';

const mocks = vi.hoisted(() => ({ approve: vi.fn(), open: vi.fn() }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/client/hooks/use-app-navigation-data', () => ({
  getProjectSlugFromPath: () => 'beta',
  useAppNavigationDataContext: () => ({
    projects: [
      { id: 'b', slug: 'beta', name: 'Beta' },
      { id: 'a', slug: 'alpha', name: 'Alpha' },
    ],
    selectedProjectSlug: 'beta',
    selectProjectSlug: vi.fn(),
  }),
}));
vi.mock('@/client/components/pr-detail-panel', () => ({ PRDetailPanel: () => null }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      prReview: { listReviewRequests: { invalidate: vi.fn() } },
      client: { prReview: { getDiff: { query: vi.fn() } } },
    }),
    prReview: {
      listReviewRequests: {
        useQuery: () => ({
          data: {
            prs: [1, 2].map((number) => ({
              number,
              repository: { nameWithOwner: 'o/r' },
              title: `PR ${number}`,
              url: `https://github.com/o/r/pull/${number}`,
              author: { login: 'author' },
              createdAt: '2026-01-01T00:00:00Z',
              isDraft: false,
              reviewDecision: 'REVIEW_REQUIRED',
              additions: 1,
              deletions: 0,
              changedFiles: 1,
            })),
          },
        }),
      },
      getPRDetails: { useQuery: () => ({}) },
      submitReview: { useMutation: () => ({ mutate: mocks.approve, isPending: false }) },
    },
  },
}));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  vi.spyOn(window, 'open').mockImplementation(mocks.open);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={['/projects/beta/reviews']}>
        <ProjectHeaderNavigation project={{ id: 'b', slug: 'beta', name: 'Beta' }} />
        <ReviewDashboard project={{ id: 'b', githubOwner: 'o', githubRepo: 'r' }} />
      </MemoryRouter>
    )
  );
  return {
    container,
    cleanup: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}
async function key(
  target: EventTarget,
  value: string,
  options: KeyboardEventInit = {},
  consumed = false
) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  if (consumed) {
    event.preventDefault();
  }
  await act(() => {
    target.dispatchEvent(event);
  });
}
function selected(container: HTMLElement) {
  return container.querySelector('button.bg-muted [title^="PR "]')?.textContent;
}
it('lets actual project-selector typeahead consume review shortcuts without approving, opening, or changing selection', async () => {
  const view = await render();
  try {
    await key(view.container.querySelector('[role="combobox"]')!, 'ArrowDown');
    const option = document.querySelector('[role="listbox"] [role="option"]');
    expect(option).not.toBeNull();
    for (const value of ['a', 'o', 'j', 'k']) {
      await key(option!, value);
    }
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(selected(view.container)).toBe('PR 1');
  } finally {
    await view.cleanup();
  }
});
it.each([
  ['consumed', {}, true],
  ['control', { ctrlKey: true }, false],
  ['command', { metaKey: true }, false],
  ['alt', { altKey: true }, false],
  ['shift', { shiftKey: true }, false],
])('yields to %s keyboard events', async (_label, options, consumed) => {
  const view = await render();
  try {
    await key(document.body, 'a', options, consumed);
    expect(mocks.approve).not.toHaveBeenCalled();
  } finally {
    await view.cleanup();
  }
});
it.each([
  'combobox',
  'listbox',
  'option',
  'menu',
  'menuitem',
  'dialog',
  'alertdialog',
  'textbox',
  'contenteditable',
])('yields to a focused %s context', async (role) => {
  const view = await render();
  const context = document.createElement('div');
  if (role === 'contenteditable') {
    context.setAttribute('contenteditable', 'true');
  } else {
    context.setAttribute('role', role);
  }
  const target = document.createElement('span');
  context.append(target);
  document.body.append(context);
  try {
    await key(target, 'a');
    await key(target, 'j');
    await key(target, 'o');
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(selected(view.container)).toBe('PR 1');
  } finally {
    context.remove();
    await view.cleanup();
  }
});
it('preserves deliberate page-level selection, approval, and open shortcuts', async () => {
  const view = await render();
  try {
    await key(document.body, 'j');
    expect(selected(view.container)).toBe('PR 2');
    await key(document.body, 'a');
    expect(mocks.approve).toHaveBeenLastCalledWith({ repo: 'o/r', number: 2, action: 'approve' });
    await key(document.body, 'k');
    await key(document.body, 'o');
    expect(selected(view.container)).toBe('PR 1');
    expect(mocks.open).toHaveBeenCalledWith('https://github.com/o/r/pull/1', '_blank');
  } finally {
    await view.cleanup();
  }
});

it('preserves review shortcuts after focusing and selecting an actual PRInboxItem row', async () => {
  const view = await render();
  try {
    const row = view.container.querySelector('[title="PR 1"]')?.closest('button');
    expect(row).toBeInstanceOf(HTMLButtonElement);
    await act(() => {
      row!.focus();
      row!.click();
    });
    expect(document.activeElement).toBe(row);
    await key(row!, 'j');
    expect(selected(view.container)).toBe('PR 2');
    await key(row!, 'a');
    expect(mocks.approve).toHaveBeenLastCalledWith({ repo: 'o/r', number: 2, action: 'approve' });
    await key(row!, 'k');
    await key(row!.querySelector('[title="PR 1"]')!, 'o');
    expect(selected(view.container)).toBe('PR 1');
    expect(mocks.open).toHaveBeenCalledWith('https://github.com/o/r/pull/1', '_blank');
  } finally {
    await view.cleanup();
  }
});
it.each(['dialog', 'menu'])(
  'keeps %s precedence over focused review-row shortcuts',
  async (role) => {
    const view = await render();
    try {
      view.container.setAttribute('role', role);
      const row = view.container.querySelector('[title="PR 1"]')?.closest('button');
      await act(() => row!.focus());
      for (const value of ['a', 'o', 'j', 'k']) {
        await key(row!, value);
      }
      expect(mocks.approve).not.toHaveBeenCalled();
      expect(mocks.open).not.toHaveBeenCalled();
      expect(selected(view.container)).toBe('PR 1');
    } finally {
      await view.cleanup();
    }
  }
);
it('keeps unrelated shared-header buttons outside the review-row exception', async () => {
  const view = await render();
  try {
    const projectButton = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Beta workspaces"]'
    );
    expect(projectButton).not.toBeNull();
    await act(() => projectButton!.focus());
    for (const value of ['a', 'o', 'j', 'k']) {
      await key(projectButton!, value);
    }
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(selected(view.container)).toBe('PR 1');
  } finally {
    await view.cleanup();
  }
});
