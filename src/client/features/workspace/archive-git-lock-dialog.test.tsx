// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveGitLockDialog } from './archive-git-lock-dialog';

describe('ArchiveGitLockDialog', () => {
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

  it('offers a safe retry and an explicit remove-lock recovery action', () => {
    const onOpenChange = vi.fn();
    const onRetry = vi.fn();
    const onRemoveLockAndArchive = vi.fn();
    void act(() => {
      root.render(
        createElement(ArchiveGitLockDialog, {
          open: true,
          onOpenChange,
          onRetry,
          onRemoveLockAndArchive,
        })
      );
    });

    expect(document.body.textContent).toContain('Another Git operation may be running');

    const retryButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    const removeButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Remove Lock and Archive'
    );
    expect(retryButton).toBeDefined();
    expect(removeButton).toBeDefined();

    void act(() => retryButton?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRetry).toHaveBeenCalledOnce();

    void act(() => removeButton?.click());
    expect(onRemoveLockAndArchive).toHaveBeenCalledOnce();
  });
});
