// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FileCode } from './file-code';

const loader = vi.hoisted(() => {
  const pending = Promise.withResolvers<never>();
  return { pending: pending.promise, rejectLoad: pending.reject };
});
vi.mock('react-syntax-highlighter/dist/esm/prism', () => loader.pending);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each(['text', 'plain', 'plaintext', 'txt'])(
  'renders %s immediately without waiting for the syntax chunk',
  async (language) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(FileCode, {
            content: '<literal>\n  whitespace\n',
            language,
            theme: 'light',
          })
        )
      );
      expect(container.querySelector('pre')?.getAttribute('aria-busy')).toBe('false');
      expect(container.querySelector('code')?.textContent).toBe('1<literal>\n2  whitespace\n3');
      expect(container.querySelector('.token')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  }
);

it('keeps numbered source readable when the highlighting chunk fails to load', async () => {
  const container = document.createElement('div');
  const caught: unknown[] = [];
  const root = createRoot(container, { onCaughtError: (error) => caught.push(error) });
  const props = { content: 'first\n  second\n', language: 'unknown', theme: 'light' as const };
  try {
    await act(async () => root.render(createElement(FileCode, props)));
    expect(container.querySelector('pre')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('pre')?.textContent).toBe('1first\n2  second\n3');
    expect(container.querySelector('.token')).toBeNull();
    await act(async () => {
      loader.rejectLoad(new Error('Chunk unavailable'));
      await loader.pending.catch(() => undefined);
    });
    expect(caught).toHaveLength(1);
    expect(container.querySelector('pre')?.getAttribute('aria-busy')).toBe('false');
    const code = container.querySelector('code')!.cloneNode(true) as HTMLElement;
    code
      .querySelectorAll('.react-syntax-highlighter-line-number')
      .forEach((number) => number.remove());
    expect(code.textContent).toBe('first\n  second\n');
    expect(
      [...container.querySelectorAll('.react-syntax-highlighter-line-number')].map(
        (number) => number.textContent
      )
    ).toEqual(['1', '2', '3']);
    await act(async () =>
      root.render(createElement(FileCode, { ...props, content: 'another file', theme: 'dark' }))
    );
    expect(container.querySelector('pre')?.textContent).toContain('another file');
    expect(container.querySelector('pre')?.getAttribute('data-syntax-theme')).toBe('dark');
  } finally {
    await act(async () => root.unmount());
  }
});
