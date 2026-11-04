// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import ProjectSettingsPage from './settings';

const mocks = vi.hoisted(() => ({
  error: null as Error | null,
  data: [
    { id: '1', slug: 'alpha', name: 'Alpha' },
    { id: '2', slug: 'beta', name: 'Beta' },
  ] as { id: string; slug: string; name: string }[] | undefined,
  refetch: vi.fn(),
}));
vi.mock('@/client/components/app-header-context', () => ({ useAppHeader: vi.fn() }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    project: {
      list: {
        useQuery: () => ({
          data: mocks.data,
          error: mocks.error,
          refetch: mocks.refetch,
          isFetching: false,
        }),
      },
    },
  },
}));
vi.mock('@/client/routes/admin/ProjectSettingsSection', () => ({
  ProjectSettingsSection: ({ project }: { project: { id: string; name: string } }) =>
    createElement('section', { 'data-project': project.id }, `${project.name} configuration`),
}));
const roots: ReturnType<typeof createRoot>[] = [];
async function render(slug: string) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/projects/${slug}/settings`] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/projects/:slug/settings',
            element: createElement(ProjectSettingsPage),
          })
        )
      )
    )
  );
  return container;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  localStorage.clear();
  mocks.data = [
    { id: '1', slug: 'alpha', name: 'Alpha' },
    { id: '2', slug: 'beta', name: 'Beta' },
  ];
  mocks.error = null;
  vi.clearAllMocks();
});
it('edits only the URL project and preserves the selected project', async () => {
  localStorage.setItem(SELECTED_PROJECT_KEY, 'alpha');
  const container = await render('beta');
  expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe('2');
  expect(container.textContent).not.toContain('Alpha configuration');
  expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe('alpha');
  expect(container.querySelector('a[href="/projects/beta/workspaces"]')).not.toBeNull();
});
it('never falls back to another project for an unknown slug', async () => {
  const container = await render('missing');
  expect(container.textContent).toContain('Project not found');
  expect(container.querySelector('[data-project]')).toBeNull();
  expect(container.querySelector('a[href="/admin/project"]')).not.toBeNull();
});
it('shows recoverable failures without mounting project editors', async () => {
  mocks.data = undefined;
  mocks.error = new Error('Service unavailable');
  const container = await render('beta');
  expect(container.textContent).toContain("Couldn't load project settings");
  expect(container.querySelector('[data-project]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(mocks.refetch).toHaveBeenCalledOnce();
});

it('keeps unresolved project settings loading without mounting editors', async () => {
  mocks.data = undefined;
  mocks.error = null;
  const container = await render('beta');
  expect(container.textContent).toContain('Loading project settings…');
  expect(container.querySelector('[data-project]')).toBeNull();
});
