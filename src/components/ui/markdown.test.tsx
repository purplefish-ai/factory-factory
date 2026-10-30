// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkspaceFileLink } from '@/client/lib/workspace-file-links';
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

  it.each([
    ['backslashes', String.raw`[foo.ts](C:\repo\src\foo.ts:12)`],
    ['forward slashes', '[foo.ts](C:/repo/src/foo.ts)'],
  ])('opens Windows drive path links written with %s', (_label, content) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onWorkspaceFileLink = vi.fn();

    flushSync(() => {
      root.render(
        createElement(MarkdownRenderer, {
          content,
          resolveWorkspaceFileLink: (href: string) =>
            resolveWorkspaceFileLink(href, String.raw`C:\repo`),
          onWorkspaceFileLink,
        })
      );
    });

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toMatch(/^C:/);
    expect(link?.getAttribute('target')).toBeNull();

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    const wasNotCanceled = link?.dispatchEvent(event);

    expect(wasNotCanceled).toBe(false);
    expect(onWorkspaceFileLink).toHaveBeenCalledWith('src/foo.ts');

    root.unmount();
  });

  it('still blanks javascript: links', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const resolveLink = vi.fn((href: string) =>
      resolveWorkspaceFileLink(href, String.raw`C:\repo`)
    );

    flushSync(() => {
      root.render(
        createElement(MarkdownRenderer, {
          content: '[click me](javascript:alert(1))',
          resolveWorkspaceFileLink: resolveLink,
          onWorkspaceFileLink: vi.fn(),
        })
      );
    });

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('');

    root.unmount();
  });
});
