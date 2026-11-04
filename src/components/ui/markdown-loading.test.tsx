// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { waitForReact } from '@/test-utils/react-act';
import { MarkdownRenderer } from './markdown';

const engine = vi.hoisted(() => ({ loaded: false }));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

vi.mock('mermaid', () => {
  engine.loaded = true;
  return {
    default: {
      initialize: vi.fn(),
      mermaidAPI: { defaultConfig: { secure: ['securityLevel'] } },
      render: vi.fn(() => Promise.resolve({ svg: '<svg aria-label="Flow diagram"></svg>' })),
    },
  };
});

it('loads the diagram engine only when markdown contains a Mermaid diagram', async () => {
  // jsdom has no canvas implementation; this test covers the lazy import
  // boundary while Mermaid theme colors are exercised in the browser stories.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '#123456',
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    getImageData: () => ({ data: [18, 52, 86, 255] }),
  } as unknown as CanvasRenderingContext2D);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(() => {
      root.render(<MarkdownRenderer content="# Plain markdown" />);
    });
    expect(container.querySelector('h1')?.textContent).toBe('Plain markdown');
    expect(engine.loaded).toBe(false);

    await act(() => {
      root.render(<MarkdownRenderer content={'```mermaid\ngraph TD; A-->B\n```'} />);
    });
    await waitForReact(() => {
      expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Flow diagram');
    });
    expect(engine.loaded).toBe(true);
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  }
});
