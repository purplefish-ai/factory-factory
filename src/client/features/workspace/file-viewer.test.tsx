// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAppearance } from '@/client/lib/appearance';
import { DEFAULT_APPEARANCE } from '@/shared/appearance';
import { FileViewer } from './file-viewer';

const mocks = vi.hoisted(() => ({ theme: 'dark' }));

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
