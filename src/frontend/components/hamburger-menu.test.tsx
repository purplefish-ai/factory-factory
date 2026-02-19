// @vitest-environment jsdom

import type { ComponentProps } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { HamburgerMenu } from './hamburger-menu';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  writable: true,
  value: true,
});

type NavigationData = ComponentProps<typeof HamburgerMenu>['navData'];

function renderInDom(render: (root: Root) => void): () => void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  render(root);
  return () => {
    root.unmount();
    container.remove();
  };
}

function createNavData(): NavigationData {
  return {
    projects: [{ id: 'project-1', slug: 'demo', name: 'Demo Project' }],
    selectedProjectSlug: 'demo',
    selectedProjectId: 'project-1',
    serverWorkspaces: [
      {
        id: 'workspace-1',
        name: 'Workspace One',
        cachedKanbanColumn: 'WORKING',
        isWorking: true,
        pendingRequestType: null,
      },
      {
        id: 'workspace-2',
        name: 'Workspace Two',
        cachedKanbanColumn: 'WAITING',
        isWorking: false,
        pendingRequestType: null,
      },
    ],
    reviewCount: 0,
    handleProjectChange: () => undefined,
    needsAttention: () => false,
    clearAttention: () => undefined,
    currentWorkspaceId: 'workspace-1',
  } as unknown as NavigationData;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('HamburgerMenu', () => {
  it('closes when clicking the active workspace link', () => {
    const cleanup = renderInDom((root) => {
      flushSync(() => {
        root.render(
          <MemoryRouter initialEntries={['/projects/demo/workspaces/workspace-1']}>
            <HamburgerMenu navData={createNavData()} />
          </MemoryRouter>
        );
      });
    });

    const openButton = document.querySelector('button[aria-label="Menu"]');
    expect(openButton).not.toBeNull();
    flushSync(() => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    const activeWorkspaceLink = document.querySelector(
      'a[href="/projects/demo/workspaces/workspace-1"]'
    );
    expect(activeWorkspaceLink).not.toBeNull();
    flushSync(() => {
      activeWorkspaceLink?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    cleanup();
  });
});
