// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './markdown';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MarkdownRenderer workspace file links', () => {
  it('intercepts resolved workspace file links', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onWorkspaceFileLink = vi.fn();

    flushSync(() => {
      root.render(
        createElement(MarkdownRenderer, {
          content: '[Concerns](/Users/demo/workspace/.planning/CONCERNS.md:31)',
          resolveWorkspaceFileLink: () => '.planning/CONCERNS.md',
          onWorkspaceFileLink,
        })
      );
    });

    const link = container.querySelector('a');
    expect(link?.getAttribute('target')).toBeNull();

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const wasNotCanceled = link?.dispatchEvent(event);

    expect(wasNotCanceled).toBe(false);
    expect(onWorkspaceFileLink).toHaveBeenCalledWith('.planning/CONCERNS.md');

    root.unmount();
  });

  it('intercepts middle-clicks on resolved workspace file links', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onWorkspaceFileLink = vi.fn();

    flushSync(() => {
      root.render(
        createElement(MarkdownRenderer, {
          content: '[Concerns](/Users/demo/workspace/.planning/CONCERNS.md:31)',
          resolveWorkspaceFileLink: () => '.planning/CONCERNS.md',
          onWorkspaceFileLink,
        })
      );
    });

    const link = container.querySelector('a');
    const event = new MouseEvent('auxclick', {
      bubbles: true,
      button: 1,
      cancelable: true,
    });
    const wasNotCanceled = link?.dispatchEvent(event);

    expect(wasNotCanceled).toBe(false);
    expect(onWorkspaceFileLink).toHaveBeenCalledWith('.planning/CONCERNS.md');

    root.unmount();
  });

  it('ignores non-middle auxclicks on resolved workspace file links', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onWorkspaceFileLink = vi.fn();

    flushSync(() => {
      root.render(
        createElement(MarkdownRenderer, {
          content: '[Concerns](/Users/demo/workspace/.planning/CONCERNS.md:31)',
          resolveWorkspaceFileLink: () => '.planning/CONCERNS.md',
          onWorkspaceFileLink,
        })
      );
    });

    const link = container.querySelector('a');
    const event = new MouseEvent('auxclick', {
      bubbles: true,
      button: 2,
      cancelable: true,
    });
    const wasNotCanceled = link?.dispatchEvent(event);

    expect(wasNotCanceled).toBe(true);
    expect(onWorkspaceFileLink).not.toHaveBeenCalled();

    root.unmount();
  });

  it('keeps external links opening in a new tab', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onWorkspaceFileLink = vi.fn();

    flushSync(() => {
      root.render(
        createElement(MarkdownRenderer, {
          content: '[GitHub](https://github.com/example/repo)',
          resolveWorkspaceFileLink: () => null,
          onWorkspaceFileLink,
        })
      );
    });

    const link = container.querySelector('a');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const wasNotCanceled = link?.dispatchEvent(event);

    expect(wasNotCanceled).toBe(true);
    expect(onWorkspaceFileLink).not.toHaveBeenCalled();

    root.unmount();
  });
});
