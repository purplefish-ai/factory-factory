// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { setPendingWorkspace } from '@/client/lib/pending-workspace';
import WorkspaceDetailPage from './detail';

const renderDetail = vi.hoisted(() => vi.fn());
vi.mock('./workspace-detail-container', () => ({
  WorkspaceDetailContainer: () => {
    renderDetail();
    return null;
  },
}));

async function fixture(id: string) {
  const router = createMemoryRouter(
    [
      { path: '/projects/:slug/workspaces/:id', element: createElement(WorkspaceDetailPage) },
      { path: '/elsewhere', element: createElement('p', null, 'Elsewhere') },
    ],
    { initialEntries: [`/projects/project/workspaces/${id}`] }
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(createElement(RouterProvider, { router })));
  return { router, container, root };
}

describe('selected pending workspace', () => {
  it('bounds completed launch history without evicting a pending request', async () => {
    setPendingWorkspace('optimistic-retained-pending', {
      status: 'creating',
      name: 'Still pending',
    });
    setPendingWorkspace('optimistic-old-completed', {
      status: 'failed',
      message: 'Old launch failed',
    });
    for (let index = 0; index < 100; index++) {
      setPendingWorkspace(`optimistic-completed-${index}`, {
        status: 'failed',
        message: `Failure ${index}`,
      });
    }
    const old = await fixture('optimistic-old-completed');
    const pending = await fixture('optimistic-retained-pending');
    const recent = await fixture('optimistic-completed-99');
    try {
      expect(old.container.textContent).toContain('This launch is no longer available');
      expect(pending.container.textContent).toContain('Creating Still pending');
      expect(recent.container.textContent).toContain('Failure 99');
    } finally {
      await act(() => {
        old.root.unmount();
        pending.root.unmount();
        recent.root.unmount();
      });
      old.router.dispose();
      pending.router.dispose();
      recent.router.dispose();
    }
  });

  it('shows progress without mounting workspace queries and replaces the temporary route on success', async () => {
    const id = 'optimistic-success';
    setPendingWorkspace(id, { status: 'creating', name: 'My task' });
    renderDetail.mockClear();
    const f = await fixture(id);
    try {
      expect(f.container.textContent).toContain('Creating My task');
      expect(renderDetail).not.toHaveBeenCalled();
      await act(async () => setPendingWorkspace(id, { status: 'created', workspaceId: 'real-id' }));
      expect(f.router.state.location.pathname).toBe('/projects/project/workspaces/real-id');
      expect(f.router.state.historyAction).toBe('REPLACE');
      expect(renderDetail).toHaveBeenCalled();
    } finally {
      await act(async () => f.root.unmount());
      f.router.dispose();
    }
  });

  it('does not navigate back when creation finishes after the user leaves', async () => {
    const id = 'optimistic-left';
    setPendingWorkspace(id, { status: 'creating', name: 'My task' });
    const f = await fixture(id);
    try {
      await act(async () => f.router.navigate('/elsewhere'));
      await act(async () => setPendingWorkspace(id, { status: 'created', workspaceId: 'real-id' }));
      expect(f.router.state.location.pathname).toBe('/elsewhere');
    } finally {
      await act(async () => f.root.unmount());
      f.router.dispose();
    }
  });

  it('shows creation errors with a way back to the retained draft', async () => {
    const id = 'optimistic-failure';
    setPendingWorkspace(id, { status: 'creating', name: 'My task' });
    const f = await fixture(id);
    try {
      await act(async () =>
        setPendingWorkspace(id, { status: 'failed', message: 'CLI unavailable' })
      );
      expect(f.container.querySelector('[role="alert"]')?.textContent).toBe('CLI unavailable');
      expect(f.container.querySelector('a')?.getAttribute('href')).toBe(
        '/projects/project/workspaces?new=1'
      );
    } finally {
      await act(async () => f.root.unmount());
      f.router.dispose();
    }
  });
});
