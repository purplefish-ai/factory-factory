// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveGitLockDialog } from './archive-git-lock-dialog';

describe('ArchiveGitLockDialog', () => {
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

  it('holds both recovery actions and stays open while archives are in flight', () => {
    const onOpenChange = vi.fn();
    const onRetry = vi.fn();
    void act(() => {
      root.render(
        createElement(ArchiveGitLockDialog, {
          open: true,
          onOpenChange,
          onRetry,
          onRemoveLockAndArchive: vi.fn(),
          workspaceCount: 2,
          isPending: true,
        })
      );
    });

    const buttons = [...document.querySelectorAll('button')];
    for (const name of ['Cancel', 'Retry', 'Remove Lock and Archive']) {
      expect(buttons.find((button) => button.textContent === name)?.disabled).toBe(true);
    }
    void act(() => {
      document
        .querySelector('[role="alertdialog"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
