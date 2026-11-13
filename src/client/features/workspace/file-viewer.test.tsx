// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAppearance } from '@/client/lib/appearance';
import { DEFAULT_APPEARANCE } from '@/shared/appearance';
import { FileCode } from './file-code';
import { FileViewer } from './file-viewer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  theme: 'dark',
  size: 12,
  truncated: false,
  isBinary: false,
  image: undefined as { mimeType: string; data: string } | undefined,
}));

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: mocks.theme }) }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      readFile: {
        useQuery: () => ({
          data: {
            content: 'const x = 1;',
            language: 'typescript',
            size: mocks.size,
            isBinary: mocks.isBinary,
            image: mocks.image,
            truncated: mocks.truncated,
          },
          isLoading: false,
          error: null,
        }),
      },
    },
  },
}));
vi.mock('./use-persistent-scroll', () => ({
  usePersistentScroll: () => ({ handleScroll: vi.fn() }),
}));

afterEach(() => {
  applyAppearance(DEFAULT_APPEARANCE);
  mocks.size = 12;
  mocks.truncated = false;
  mocks.isBinary = false;
  mocks.image = undefined;
});

describe('FileViewer appearance', () => {
  it.each(['dark', 'light'])('uses the saved monospace font in %s mode', (theme) => {
    mocks.theme = theme;
    applyAppearance({
      ...DEFAULT_APPEARANCE,
      fontMono: '"Atkinson Hyperlegible Mono", monospace',
    });
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      createElement(FileViewer, {
        workspaceId: 'workspace-1',
        filePath: 'example.ts',
        tabId: 'file-1',
      })
    );

    expect(container.querySelector('pre')?.style.fontFamily).toBe('var(--font-mono)');
    expect(container.querySelector('code')?.style.fontFamily).toBe('var(--font-mono)');
    expect(container.textContent).toContain('const x = 1;');
  });
});

it('keeps source text and every line available before the worker responds', () => {
  const content = '/* first\n\nlast */\n';
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    createElement(FileCode, { content, language: 'typescript', theme: 'dark' })
  );
  expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('1\n2\n3\n4');
  container.querySelectorAll('[aria-hidden="true"]').forEach((number) => number.remove());
  expect(container.querySelector('code')?.textContent).toBe(content);
});

it('groups large source into bounded text blocks while retaining browser-find text', () => {
  const content = 'const value = 1;\n'.repeat(20_000);
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    createElement(FileCode, { content, language: 'typescript', theme: 'dark' })
  );
  const blocks = [...container.querySelectorAll('code')];
  expect(blocks).toHaveLength(Math.ceil(20_001 / 128));
  expect(blocks.length).toBeGreaterThan(1);
  let totalLines = 0;
  blocks.forEach((block, index) => {
    const lines =
      (block.textContent ?? '').split('\n').length - (index < blocks.length - 1 ? 1 : 0);
    expect(lines).toBeGreaterThan(0);
    expect(lines).toBeLessThanOrEqual(128);
    totalLines += lines;
  });
  expect(totalLines).toBe(20_001);
  expect(container.querySelectorAll('pre *').length).toBeLessThan(1000);
  container.querySelectorAll('[aria-hidden="true"]').forEach((number) => number.remove());
  expect(container.querySelector('pre')?.textContent).toBe(content);
});

it.each(['ready', 'pending', 'visible'])(
  'preserves a selected search result during %s highlighting',
  async (timing) => {
    const observed: Array<{ element: Element; callback: IntersectionObserverCallback }> = [];
    let respond: ((event: MessageEvent) => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: IntersectionObserverCallback) {}
        observe(element: Element) {
          observed.push({ element, callback: this.callback });
        }
        disconnect = vi.fn();
      }
    );
    vi.stubGlobal(
      'Worker',
      class {
        set onmessage(callback: (event: MessageEvent) => void) {
          respond = callback;
        }
        postMessage = vi.fn();
        terminate = vi.fn();
      }
    );
    const content = Array.from({ length: 400 }, (_, index) => `source line ${index}`).join('\n');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(createElement(FileCode, { content, language: 'typescript', theme: 'dark' }))
      );
      const respondWithTokens = () =>
        respond?.(
          new MessageEvent('message', {
            data: new Map(
              content
                .split('\n')
                .map((line, index) => [index, [{ content: line, className: 'token comment' }]])
            ),
          })
        );
      if (timing === 'ready') {
        await act(respondWithTokens);
      }
      const block = observed.at(-1);
      const text = block?.element.querySelector('code')?.firstChild;
      expect(text).toBeDefined();
      if (!(text && block)) {
        throw new Error('Missing source block');
      }
      if (timing === 'visible') {
        await act(() =>
          block.callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            {} as IntersectionObserver
          )
        );
      }
      const range = document.createRange();
      const offset = text.textContent?.indexOf('source line 399') ?? -1;
      range.setStart(text, offset);
      range.setEnd(text, offset + 'source line 399'.length);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (timing !== 'ready') {
        await act(respondWithTokens);
      }
      await act(() =>
        block.callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      );
      expect(selection?.toString()).toBe('source line 399');
      await act(() => {
        selection?.removeAllRanges();
        document.dispatchEvent(new Event('selectionchange'));
      });
      expect(block.element.querySelector('code .token')).not.toBeNull();
      if (timing === 'ready') {
        const highlighted = block.element.querySelectorAll('code .token').item(15)?.firstChild;
        if (!highlighted) {
          throw new Error('Missing highlighted source');
        }
        const selected = document.createRange();
        selected.selectNodeContents(highlighted);
        selection?.addRange(selected);
        for (const visible of [false, true]) {
          await act(() =>
            block.callback(
              [{ isIntersecting: visible } as IntersectionObserverEntry],
              {} as IntersectionObserver
            )
          );
          expect(selection?.toString()).toBe('source line 399');
        }
        const updated = content.replaceAll('source', 'changed');
        await act(() =>
          root.render(
            createElement(FileCode, { content: updated, language: 'text', theme: 'dark' })
          )
        );
        expect(container.textContent).toContain('changed line 399');
        expect(container.textContent).not.toContain('source line 399');
      }
    } finally {
      await act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  }
);

it('shows gigabytes consistently in the file header and truncation warning', () => {
  mocks.size = 1024 ** 3;
  mocks.truncated = true;
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    createElement(FileViewer, { workspaceId: 'workspace-1', filePath: 'large.ts', tabId: 'large' })
  );
  expect(container.textContent).toContain('1.0 GB');
  expect(container.textContent).toContain('File truncated to 1MB. Actual size: 1.0 GB');
  expect(container.textContent).not.toContain('1024.0 MB');
});

it('renders images instead of the binary warning and handles decoding failures', async () => {
  mocks.isBinary = true;
  mocks.image = { mimeType: 'image/png', data: 'aGVsbG8=' };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        createElement(FileViewer, {
          workspaceId: 'workspace-1',
          filePath: 'photo.png',
          tabId: 'image-1',
        })
      )
    );
    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    expect(image?.alt).toBe('photo.png');
    expect(container.textContent).not.toContain('Binary file cannot be displayed');
    expect(container.querySelector('code')).toBeNull();
    await act(() => image?.dispatchEvent(new Event('error')));
    expect(container.textContent).toContain("Couldn't display image");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it('preserves the warning for other binary files', () => {
  mocks.isBinary = true;
  const markup = renderToStaticMarkup(
    createElement(FileViewer, {
      workspaceId: 'workspace-1',
      filePath: 'archive.zip',
      tabId: 'binary-1',
    })
  );
  expect(markup).toContain('Binary file cannot be displayed');
  expect(markup).not.toContain('<img');
});
