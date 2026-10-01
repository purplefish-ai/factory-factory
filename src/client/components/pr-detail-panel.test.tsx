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
          container.querySelectorAll('.font-medium.truncate'),
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
