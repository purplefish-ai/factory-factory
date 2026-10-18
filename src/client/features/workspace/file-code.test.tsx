// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FileCode } from './file-code';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.unstubAllGlobals());

it.each(['text', 'plain', 'plaintext', 'txt'])(
  'renders %s immediately without waiting for the syntax chunk',
  async (language) => {
    const worker = vi.fn();
    vi.stubGlobal('Worker', worker);
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
      expect(container.querySelector('code')?.textContent).toBe('<literal>\n  whitespace\n');
      expect(container.querySelector('.token')).toBeNull();
      expect(worker).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  }
);

it.each(['load', 'message', 'construct'])(
  'keeps numbered source readable after worker %s failure',
  async (failure) => {
    let failed: (() => void) | undefined;
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          if (failure === 'construct') {
            throw new Error('Worker unavailable');
          }
        }
        onerror?: () => void;
        onmessageerror?: () => void;
        terminate = vi.fn();
        postMessage() {
          failed = () => (failure === 'message' ? this.onmessageerror?.() : this.onerror?.());
        }
      }
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    const props = { content: 'first\n  second\n', language: 'unknown', theme: 'light' as const };
    try {
      await act(() => root.render(createElement(FileCode, props)));
      expect(container.querySelector('pre')?.getAttribute('aria-busy')).toBe(
        failure === 'construct' ? 'false' : 'true'
      );
      expect(container.querySelector('code')?.textContent).toBe(props.content);
      await act(() => {
        failed?.();
      });
      const pre = container.querySelector('pre');
      expect(pre?.getAttribute('aria-busy')).toBe('false');
      expect(container.querySelector('code')?.textContent).toBe(props.content);
      expect(container.querySelector('.token')).toBeNull();
      expect(container.querySelector('.react-syntax-highlighter-line-number')?.textContent).toBe(
        '1\n2\n3'
      );
      await act(() =>
        root.render(
          createElement(FileCode, {
            ...props,
            content: '<literal> & another file\n',
            theme: 'dark',
          })
        )
      );
      expect(container.querySelector('pre')).toBe(pre);
      expect(container.querySelector('code')?.textContent).toBe('<literal> & another file\n');
      expect(pre?.getAttribute('data-syntax-theme')).toBe('dark');
    } finally {
      await act(() => root.unmount());
    }
  }
);
