// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceCreationDraft } from '@/client/features/kanban/use-workspace-creation-draft';
import { getWorkspaceCreationDraftSnapshot } from '@/client/features/kanban/workspace-creation-draft-storage';
import type { AppNavigationData } from '@/client/hooks/use-app-navigation-data';
import { SidebarProvider } from '@/components/ui/sidebar';
import { waitForReact } from '@/test-utils/react-act';
import { AppSidebar } from './app-sidebar';

const formChunk = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { loaded, release: () => release() };
});

vi.mock('@/client/hooks/use-project-issues', () => ({ useProjectIssues: () => ({ issues: [] }) }));
vi.mock('@/hooks/use-mobile', () => ({ MOBILE_BREAKPOINT: 768, useIsMobile: () => false }));
vi.mock('./theme-toggle', () => ({ ThemeToggle: () => null }));
// Hold the lazily loaded form chunk so the drop lands while it is still loading.
vi.mock('@/client/features/kanban/inline-workspace-form', async () => {
  await formChunk.loaded;
  return {
    InlineWorkspaceForm: ({ projectId }: { projectId: string }) => {
      const { draft } = useWorkspaceCreationDraft(projectId);
      return (
        <section aria-label="New workspace">
          {draft.attachments.map(({ id, name }) => (
            <span key={id}>{name}</span>
          ))}
        </section>
      );
    },
  };
});

const projectId = 'sidebar-drop-project';
const navigation: AppNavigationData = {
  projects: [],
  projectsError: null,
  refetchProjects: vi.fn(),
  selectedProjectSlug: projectId,
  selectedProjectId: projectId,
  selectProjectSlug: vi.fn(),
  issueProvider: 'GITHUB',
  serverWorkspaces: [],
  reviewCount: 0,
  agentsSummary: undefined,
  needsAttention: () => false,
  clearAttention: vi.fn(),
  currentWorkspaceId: undefined,
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('saves an image dropped on the sidebar while the creation form is still loading', async () => {
  await act(() =>
    root.render(
      <MemoryRouter initialEntries={[`/projects/${projectId}/workspaces`]}>
        <SidebarProvider>
          <AppSidebar navData={navigation} />
        </SidebarProvider>
      </MemoryRouter>
    )
  );
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', {
    value: {
      items: [{ kind: 'file', type: 'image/png' }],
      files: [new File(['image'], 'queued.png', { type: 'image/png' })],
    },
  });
  await act(() => container.querySelector('[data-sidebar="content"]')!.dispatchEvent(drop));

  await waitForReact(() =>
    expect(
      getWorkspaceCreationDraftSnapshot(projectId).draft?.attachments.map(({ name }) => name)
    ).toEqual(['queued.png'])
  );
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Loading new workspace form…'
  );
  expect(container.querySelector('[aria-label="New workspace"]')).toBeNull();

  formChunk.release();
  await waitForReact(() =>
    expect(container.querySelector('[aria-label="New workspace"]')?.textContent).toBe('queued.png')
  );
});

it('closes the new workspace form when another project is selected', async () => {
  formChunk.release();
  const sidebar = (navData: AppNavigationData) => (
    <MemoryRouter initialEntries={[`/projects/${projectId}/workspaces`]}>
      <SidebarProvider>
        <AppSidebar navData={navData} />
      </SidebarProvider>
    </MemoryRouter>
  );
  await act(() => root.render(sidebar(navigation)));
  const newWorkspace = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'New workspace'
  );
  await act(() => newWorkspace?.click());
  await waitForReact(() =>
    expect(container.querySelector('[aria-label="New workspace"]')).not.toBeNull()
  );

  await act(() =>
    root.render(
      sidebar({ ...navigation, selectedProjectSlug: 'other', selectedProjectId: 'other-id' })
    )
  );
  expect(container.querySelector('[aria-label="New workspace"]')).toBeNull();
  expect(container.textContent).toContain('New workspace');
});
