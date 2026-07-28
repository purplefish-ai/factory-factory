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
    void act(() => {
      root.render(
        createElement(ArchiveWorkspaceDialog, {
          open: true,
          onOpenChange: vi.fn(),
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
  });
});
