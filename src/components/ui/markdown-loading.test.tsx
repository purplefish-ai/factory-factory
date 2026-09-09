// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
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
      render: vi.fn(() => Promise.resolve({ svg: '<svg aria-label="Flow diagram"></svg>' })),
    },
  };
});

it('loads the diagram engine only when markdown contains a Mermaid diagram', async () => {
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
    await vi.waitFor(() => {
      expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Flow diagram');
    });
    expect(engine.loaded).toBe(true);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
