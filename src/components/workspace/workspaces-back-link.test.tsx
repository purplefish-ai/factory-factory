// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspacesBackLink } from './workspaces-back-link';

const setOpen = vi.fn();
const setOpenMobile = vi.fn();

vi.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({
    setOpen,
    setOpenMobile,
  }),
}));

afterEach(() => {
  setOpen.mockReset();
  setOpenMobile.mockReset();
  document.body.innerHTML = '';
});

describe('WorkspacesBackLink', () => {
  it('closes desktop and mobile sidebars before navigating', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(WorkspacesBackLink, {
            projectSlug: 'demo',
          })
        )
      );
    });

    const link = container.querySelector('a[href="/projects/demo/workspaces"]');
    expect(link).not.toBeNull();

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(setOpen).toHaveBeenCalledWith(false);
    expect(setOpenMobile).toHaveBeenCalledWith(false);

    root.unmount();
  });
});
