// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PRWithFullDetails } from '@/shared/github-types';
import { PRDetailPanel } from './pr-detail-panel';

const pr: PRWithFullDetails = {
  number: 1,
  title: 'Fixture PR',
  url: 'https://github.com/example/repo/pull/1',
  author: { login: 'fixture' },
  repository: { name: 'repo', nameWithOwner: 'example/repo' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  isDraft: false,
  state: 'OPEN',
  reviewDecision: null,
  statusCheckRollup: [],
  reviews: [],
  comments: [],
  labels: [],
  additions: 3,
  deletions: 3,
  changedFiles: 3,
  headRefName: 'fixture',
  baseRefName: 'main',
  mergeStateStatus: 'CLEAN',
};

describe('PRDetailPanel diff filenames', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => vi.unstubAllGlobals());
  it('renders complete parsed paths on the Diff tab with their changes', async () => {
    const paths = ['src/lib/utils.ts', '.github/workflows/ci.yml', 'web/my b/file.ts'];
    const diff = paths
      .map(
        (name) => `diff --git a/${name} b/${name}
@@ -1 +1 @@
-old
+new`
      )
      .join('\n');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <PRDetailPanel
            pr={pr}
            diff={diff}
            diffLoading={false}
            onFetchDiff={vi.fn()}
            onOpenGitHub={vi.fn()}
            onApprove={vi.fn()}
          />
        )
      );
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' })));

      expect(
        Array.from(
          container.querySelectorAll('[data-testid="diff-file-name"]'),
          (label) => label.textContent
        )
      ).toEqual(paths);
      expect(container.textContent).toContain('old');
      expect(container.textContent).toContain('new');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe('PRDetailPanel keyboard shortcuts', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function renderPanel() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onFetchDiff = vi.fn();
    await act(async () =>
      root.render(
        <PRDetailPanel
          pr={pr}
          diff={null}
          diffLoading={false}
          onFetchDiff={onFetchDiff}
          onOpenGitHub={vi.fn()}
          onApprove={vi.fn()}
        />
      )
    );
    const activeTab = () =>
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
    const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) =>
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        );
      });
    return { container, root, activeTab, press, onFetchDiff };
  }

  it('keeps d and i working after clicking a tab trigger', async () => {
    const view = await renderPanel();
    try {
      const infoTab = view.container.querySelector<HTMLElement>('[role="tab"]');
      await act(() => infoTab?.focus());
      expect(document.activeElement).toBe(infoTab);
      await view.press(infoTab!, 'd');
      expect(view.activeTab()).toBe('Diff');
    } finally {
      await act(async () => view.root.unmount());
    }
  });

  it('switches tabs on plain d and i', async () => {
    const view = await renderPanel();
    try {
      await view.press(window, 'd');
      expect(view.activeTab()).toBe('Diff');
      await view.press(window, 'i');
      expect(view.activeTab()).toBe('Info');
    } finally {
      await act(async () => view.root.unmount());
    }
  });

  it.each([
    ['command', { metaKey: true }],
    ['control', { ctrlKey: true }],
    ['alt', { altKey: true }],
  ])('yields %s+d to the browser', async (_label, init) => {
    const view = await renderPanel();
    try {
      const event = new KeyboardEvent('keydown', { key: 'd', cancelable: true, ...init });
      await act(() => {
        window.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(view.activeTab()).toBe('Info');
      expect(view.onFetchDiff).not.toHaveBeenCalled();
    } finally {
      await act(async () => view.root.unmount());
    }
  });

  it('ignores d typed into a contenteditable or select', async () => {
    const view = await renderPanel();
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const select = document.createElement('select');
    document.body.append(editor, select);
    try {
      await view.press(editor, 'd');
      await view.press(select, 'd');
      expect(view.activeTab()).toBe('Info');
    } finally {
      await act(async () => view.root.unmount());
    }
  });

  it('advertises Shift+A for approval', async () => {
    const view = await renderPanel();
    try {
      const approve = [...view.container.querySelectorAll('button')].find((button) =>
        button.textContent?.startsWith('Approve')
      );
      expect(approve?.getAttribute('aria-keyshortcuts')).toBe('Shift+A');
      expect(
        [...(approve?.querySelectorAll('[data-slot="kbd"]') ?? [])].map((kbd) => kbd.textContent)
      ).toEqual(['⇧', 'A']);
    } finally {
      await act(async () => view.root.unmount());
    }
  });
});
