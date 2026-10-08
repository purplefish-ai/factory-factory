// @vitest-environment jsdom
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';

const mocks = vi.hoisted(() => ({
  listForProject: vi.fn(() => ({ data: { workspaces: [], reviewCount: 0 } })),
  mutate: vi.fn(),
}));
const mutation = { mutate: mocks.mutate };
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    project: {
      list: {
        useQuery: () => ({
          data: [
            { id: 'alpha-id', slug: 'alpha', name: 'Alpha', issueProvider: 'GITHUB' },
            { id: 'new-id', slug: 'new', name: 'New', issueProvider: 'GITHUB' },
          ],
        }),
      },
    },
    workspace: {
      listForProject: { useQuery: mocks.listForProject },
      syncAllPRStatuses: { useMutation: () => mutation },
    },
  },
}));
vi.mock('@/client/hooks/use-project-snapshot-sync', () => ({ useProjectSnapshotSync: vi.fn() }));
vi.mock('@/client/hooks/use-workspace-attention', () => ({
  useWorkspaceAttention: () => ({ needsAttention: () => false, clearAttention: vi.fn() }),
}));

import { getProjectSlugFromPath, useAppNavigationData } from './use-app-navigation-data';

describe('project route selection', () => {
  it.each(['/projects/new', '/projects/new/'])('keeps %s as the project creation route', (path) => {
    expect(getProjectSlugFromPath(path)).toBeNull();
  });

  it.each(['/projects/new/workspaces', '/projects/new/settings', '/projects/new/workspaces/w1'])(
    'recognizes the project slug in %s',
    (path) => {
      expect(getProjectSlugFromPath(path)).toBe('new');
    }
  );

  it('selects and persists the URL project instead of the stored or first project', () => {
    localStorage.setItem(SELECTED_PROJECT_KEY, 'alpha');
    window.history.replaceState({}, '', '/projects/new/workspaces');
    const container = document.createElement('div');
    const root = createRoot(container);
    let selectedProjectSlug: string | undefined;
    let selectedProjectId: string | undefined;
    function Harness() {
      const navigation = useAppNavigationData();
      selectedProjectSlug = navigation.selectedProjectSlug;
      selectedProjectId = navigation.selectedProjectId;
      return null;
    }
    try {
      flushSync(() =>
        root.render(
          createElement(
            MemoryRouter,
            {
              initialEntries: ['/projects/new/workspaces'],
            },
            createElement(Harness)
          )
        )
      );
      expect(selectedProjectSlug).toBe('new');
      expect(selectedProjectId).toBe('new-id');
      expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe('new');
      expect(mocks.listForProject).toHaveBeenLastCalledWith(
        { projectId: 'new-id' },
        expect.objectContaining({ enabled: true })
      );
    } finally {
      flushSync(() => root.unmount());
      localStorage.clear();
      window.history.replaceState({}, '', '/');
    }
  });
});
