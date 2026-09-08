// @vitest-environment jsdom

import mermaid from 'mermaid';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MermaidDiagram from './mermaid-diagram';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

function deferredRender() {
  let resolve!: (value: { svg: string }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ svg: string }>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(mermaid.render).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('recovers when an invalid chart becomes valid', async () => {
  vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('Incomplete diagram'));
  await act(() => root.render(<MermaidDiagram chart="graph" />));
  expect(container.textContent).toContain('Incomplete diagram');

  vi.mocked(mermaid.render).mockResolvedValueOnce({
    svg: '<svg aria-label="Complete diagram"></svg>',
    diagramType: 'flowchart',
  });
  await act(() => root.render(<MermaidDiagram chart="graph TD; A-->B" />));
  expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Complete diagram');
  expect(container.textContent).not.toContain('Incomplete diagram');
});

it.each(['success', 'error'] as const)(
  'ignores a stale render %s after the chart changes',
  async (outcome) => {
    const oldRender = deferredRender();
    const latestRender = deferredRender();
    vi.mocked(mermaid.render)
      .mockImplementationOnce(() =>
        oldRender.promise.then((result) => ({ ...result, diagramType: 'flowchart' }))
      )
      .mockImplementationOnce(() =>
        latestRender.promise.then((result) => ({ ...result, diagramType: 'flowchart' }))
      );
    await act(() => root.render(<MermaidDiagram chart="graph TD; A-->B" />));
    await act(() => root.render(<MermaidDiagram chart="graph TD; A-->C" />));
    await act(() => latestRender.resolve({ svg: '<svg aria-label="Latest diagram"></svg>' }));

    await act(() => {
      if (outcome === 'success') {
        oldRender.resolve({ svg: '<svg aria-label="Old diagram"></svg>' });
      } else {
        oldRender.reject(new Error('Stale render error'));
      }
    });
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Latest diagram');
    expect(container.textContent).not.toContain('Stale render error');
  }
);
