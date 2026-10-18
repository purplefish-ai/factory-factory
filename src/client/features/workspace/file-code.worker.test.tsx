// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FileCode } from './file-code';

it('uses worker CSS tokens while preserving source and the mounted theme boundary', async () => {
  const workers: Array<{ onmessage?: (event: MessageEvent) => void }> = [];
  const posted = vi.fn();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        workers.push(this);
      }
      onmessage?: (event: MessageEvent) => void;
      postMessage = posted;
      terminate = vi.fn();
    }
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(element: Element) {
        this.callback(
          [{ isIntersecting: true, target: element }] as IntersectionObserverEntry[],
          this as unknown as IntersectionObserver
        );
      }
      disconnect = vi.fn();
    }
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  const props = { content: 'const value = 1;\n', language: 'typescript', theme: 'light' as const };
  try {
    await act(() => root.render(createElement(FileCode, props)));
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls[0]?.[0]).toMatchObject({ content: props.content, cssClasses: true });
    expect(container.querySelector('pre')?.getAttribute('aria-busy')).toBe('true');
    await act(() =>
      workers[0]?.onmessage?.(
        new MessageEvent('message', {
          data: new Map([
            [0, [{ content: 'const', className: 'token keyword' }, { content: ' value = 1;' }]],
            [1, []],
          ]),
        })
      )
    );
    const pre = container.querySelector('pre');
    expect(pre?.getAttribute('aria-busy')).toBe('false');
    expect(container.querySelector('.token.keyword')?.textContent).toBe('const');
    expect(container.querySelector('.token[style]')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe(props.content);
    await act(() => root.render(createElement(FileCode, { ...props, theme: 'dark' })));
    expect(container.querySelector('pre')).toBe(pre);
    expect(pre?.getAttribute('data-syntax-theme')).toBe('dark');
    expect(posted).toHaveBeenCalledTimes(1);
  } finally {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
