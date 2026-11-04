// @vitest-environment jsdom

import mermaid from 'mermaid';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MermaidDiagram from './mermaid-diagram';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
    mermaidAPI: { defaultConfig: { secure: ['securityLevel'] } },
  },
}));

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
  vi.mocked(mermaid.initialize).mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '#123456',
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    getImageData: () => ({ data: [18, 52, 86, 255] }),
  } as unknown as CanvasRenderingContext2D);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('recovers when an invalid chart becomes valid', async () => {
  vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('Incomplete diagram'));
  await act(async () => root.render(<MermaidDiagram chart="graph" />));
  expect(container.textContent).toContain('Incomplete diagram');

  vi.mocked(mermaid.render).mockResolvedValueOnce({
    svg: '<svg aria-label="Complete diagram"></svg>',
    diagramType: 'flowchart',
  });
  await act(async () => root.render(<MermaidDiagram chart="graph TD; A-->B" />));
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
    await act(async () => root.render(<MermaidDiagram chart="graph TD; A-->B" />));
    await act(async () => root.render(<MermaidDiagram chart="graph TD; A-->C" />));
    // Rendering is serialized so one chart cannot steal another chart's theme.
    expect(mermaid.render).toHaveBeenCalledTimes(1);

    await act(async () => {
      if (outcome === 'success') {
        oldRender.resolve({ svg: '<svg aria-label="Old diagram"></svg>' });
      } else {
        oldRender.reject(new Error('Stale render error'));
      }
      await oldRender.promise.catch(() => undefined);
    });
    await act(async () => latestRender.resolve({ svg: '<svg aria-label="Latest diagram"></svg>' }));
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Latest diagram');
    expect(container.textContent).not.toContain('Stale render error');
  }
);

it('uses theme tokens and rerenders on root appearance changes', async () => {
  vi.mocked(mermaid.render).mockResolvedValue({ svg: '<svg></svg>', diagramType: 'flowchart' });
  await act(async () => root.render(<MermaidDiagram chart="graph TD; A-->B" />));
  expect(mermaid.initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      theme: 'base',
      securityLevel: 'strict',
      themeVariables: expect.objectContaining({
        primaryTextColor: '#123456',
        primaryColor: '#123456',
      }),
      secure: expect.arrayContaining(['securityLevel', 'theme', 'themeVariables']),
    })
  );
  await act(async () => document.documentElement.setAttribute('data-color-scheme', 'github'));
  expect(mermaid.render).toHaveBeenCalledTimes(2);
  await act(async () => document.documentElement.style.setProperty('--foreground', '#ffffff'));
  expect(mermaid.render).toHaveBeenCalledTimes(3);
  document.documentElement.removeAttribute('data-color-scheme');
  document.documentElement.removeAttribute('style');
});

it('cleans temporary render containers after failure and permits later diagrams', async () => {
  vi.mocked(mermaid.render).mockImplementationOnce((_id, _chart, target) => {
    target?.appendChild(document.createElement('svg'));
    return Promise.reject(new Error('Incomplete'));
  });
  await act(async () => root.render(<MermaidDiagram chart="graph" />));
  expect(document.querySelector('[data-mermaid-render]')).toBeNull();
  vi.mocked(mermaid.render).mockResolvedValueOnce({ svg: '<svg></svg>', diagramType: 'flowchart' });
  await act(async () => root.render(<MermaidDiagram chart="graph TD; A-->B" />));
  expect(container.querySelector('svg')).not.toBeNull();
});

it('discards queued diagrams after unmount and cleans in-flight scratch DOM', async () => {
  const pending = deferredRender();
  vi.mocked(mermaid.render).mockImplementationOnce(() =>
    pending.promise.then((result) => ({ ...result, diagramType: 'flowchart' }))
  );
  await act(async () =>
    root.render(
      <>
        <MermaidDiagram chart="graph TD; A-->B" />
        <MermaidDiagram chart="graph TD; C-->D" />
      </>
    )
  );
  expect(mermaid.render).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  await act(async () => pending.resolve({ svg: '<svg></svg>' }));
  expect(mermaid.render).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-mermaid-render]')).toBeNull();
});
