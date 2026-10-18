// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAppearance } from '@/client/lib/appearance';
import { DEFAULT_APPEARANCE } from '@/shared/appearance';
import { FileCode } from './file-code';
import { FileViewer } from './file-viewer';

const mocks = vi.hoisted(() => ({ theme: 'dark' }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: mocks.theme }) }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      readFile: {
        useQuery: () => ({
          data: {
            content: 'const x = 1;',
            language: 'typescript',
            size: 12,
            isBinary: false,
            truncated: false,
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

describe('FileViewer highlighting', () => {
  it('shows readable numbered text before the language bundle loads', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      createElement(FileViewer, {
        workspaceId: 'workspace-1',
        filePath: 'example.ts',
        tabId: 'file-1',
      })
    );

    expect(container.querySelector('pre')?.textContent).toContain('const x = 1;');
    expect(container.querySelector('.token.keyword')).toBeNull();
    expect(container.querySelector('pre')?.getAttribute('aria-busy')).toBe('true');
    expect(
      container.querySelector('.react-syntax-highlighter-line-number')?.textContent?.trim()
    ).toBe('1');
  });

  it('highlights loaded source with CSS tokens instead of per-token styles', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(() => {
        root.render(
          createElement(FileViewer, {
            workspaceId: 'workspace-1',
            filePath: 'example.ts',
            tabId: 'file-1',
          })
        );
      });
      await vi.waitFor(
        async () => {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
          expect(
            container.querySelector('code.language-typescript .token.keyword')?.textContent
          ).toBe('const');
        },
        { timeout: 15_000 }
      );
      expect(container.querySelector('.token[style]')).toBeNull();
      expect(container.querySelector('code')?.textContent).toBe('1const x = 1;');
    } finally {
      await act(async () => root.unmount());
    }
  }, 20_000);
});

it('preserves unknown-language source and the mounted code element across theme changes', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const props = {
    content: '<literal>& text\n\tindent\n\n',
    language: 'unknown-language',
    theme: 'light' as const,
  };
  try {
    await act(async () => root.render(createElement(FileCode, props)));
    await vi.waitFor(
      async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        expect(container.querySelector('pre')?.hasAttribute('aria-busy')).toBe(false);
      },
      { timeout: 15_000 }
    );
    const pre = container.querySelector('pre');
    const code = container.querySelector('code')!.cloneNode(true) as HTMLElement;
    code
      .querySelectorAll('.react-syntax-highlighter-line-number')
      .forEach((number) => number.remove());
    expect(code.textContent).toBe('<literal>& text\n\tindent\n\n');
    expect(
      [...container.querySelectorAll('.react-syntax-highlighter-line-number')].map(
        (number) => number.textContent
      )
    ).toEqual(['1', '2', '3', '4']);
    expect(container.querySelector('.token')).toBeNull();
    await act(async () => root.render(createElement(FileCode, { ...props, theme: 'dark' })));
    expect(container.querySelector('pre')).toBe(pre);
    expect(pre?.getAttribute('data-syntax-theme')).toBe('dark');
  } finally {
    await act(async () => root.unmount());
  }
}, 20_000);
