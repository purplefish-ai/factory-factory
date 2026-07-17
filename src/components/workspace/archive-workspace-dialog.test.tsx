// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveWorkspaceDialog } from './archive-workspace-dialog';

describe('ArchiveWorkspaceDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
    void act(() => root.unmount());
    document.body.innerHTML = '';
  });

  it('blocks archive confirmation while Git status is loading', () => {
    const onConfirm = vi.fn();
    void act(() => {
      root.render(
        createElement(ArchiveWorkspaceDialog, {
          open: true,
          onOpenChange: vi.fn(),
          hasUncommitted: false,
          isCheckingGitStatus: true,
          onConfirm,
        })
      );
    });

    const archiveButton = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Checking changes')
    );
    expect(archiveButton?.disabled).toBe(true);

    void act(() => archiveButton?.click());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
