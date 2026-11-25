// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveWorkspaceDialog } from './archive-workspace-dialog';

describe('ArchiveWorkspaceDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalActEnvironmentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT'
    );
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    try {
      void act(() => root.unmount());
      document.body.innerHTML = '';
    } finally {
      if (originalActEnvironmentDescriptor) {
        Object.defineProperty(
          globalThis,
          'IS_REACT_ACT_ENVIRONMENT',
          originalActEnvironmentDescriptor
        );
      } else {
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  });

  it('always allows archive confirmation and does not expose a commit choice', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    void act(() => {
      root.render(
        createElement(ArchiveWorkspaceDialog, {
          open: true,
          onOpenChange,
          onConfirm,
        })
      );
    });

    const archiveButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Archive'
    );
    expect(archiveButton?.disabled).toBe(false);
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    expect(document.body.textContent).toContain('committed before the worktree is removed');

    void act(() => archiveButton?.click());
    expect(onConfirm).toHaveBeenCalledWith();
    // Archiving is optimistic, so confirming closes the dialog at once.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not promise a commit when archiving again after an incomplete archive', () => {
    const onConfirm = vi.fn();
    void act(() => {
      root.render(
        createElement(ArchiveWorkspaceDialog, {
          open: true,
          onOpenChange: vi.fn(),
          onConfirm,
          archiveIncomplete: true,
        })
      );
    });

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Finish archiving workspace?');
    expect(dialog?.textContent).toContain('The last archive of this workspace stopped partway');
    expect(dialog?.textContent).toContain('so nothing is committed again.');
    expect(dialog?.textContent).not.toContain('will be committed');

    const archiveButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Archive again'
    );
    void act(() => archiveButton?.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('warns about active child workspaces inside the dialog', () => {
    void act(() => {
      root.render(
        createElement(ArchiveWorkspaceDialog, {
          open: true,
          onOpenChange: vi.fn(),
          onConfirm: vi.fn(),
          activeChildCount: 2,
        })
      );
    });

    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'This workspace has 2 active child workspaces.'
    );
  });
});
