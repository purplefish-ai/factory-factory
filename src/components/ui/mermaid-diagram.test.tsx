// @vitest-environment jsdom

import mermaid from 'mermaid';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseThemeColor } from '@/client/lib/color-contrast';
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

let themeStyle: HTMLStyleElement;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(mermaid.render).mockReset();
  vi.mocked(mermaid.initialize).mockClear();
  themeStyle = document.createElement('style');
  themeStyle.textContent = `
    :root { --background: #ffffff; --foreground: #123456; --card: #abcdef; --muted: #eeeeee; --ring: #334455; }
    :root[data-color-scheme='github'] { --foreground: #654321; --card: #fedcba; }
  `;
  document.head.appendChild(themeStyle);
  const context = {
    fillStyle: '#123456',
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    getImageData() {
      const token = /^var\((--[\w-]+)\)$/.exec(this.fillStyle)?.[1];
      const value = token
        ? getComputedStyle(document.documentElement).getPropertyValue(token)
        : this.fillStyle;
      const parsed = parseThemeColor(value);
      const channels = value.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
      const data = parsed
        ? parsed.rgb.map((value) => Math.round(value * 255))
        : (channels?.slice(1).map(Number) ?? [0, 0, 0]);
      return { data: [...data, 255] };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  themeStyle.remove();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-color-scheme');
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
        primaryColor: '#abcdef',
      }),
      secure: expect.arrayContaining(['securityLevel', 'theme', 'themeVariables']),
    })
  );
  await act(async () => document.documentElement.setAttribute('data-color-scheme', 'github'));
  expect(mermaid.render).toHaveBeenCalledTimes(2);
  expect(mermaid.initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      themeVariables: expect.objectContaining({
        primaryColor: '#fedcba',
        primaryTextColor: '#654321',
      }),
    })
  );
  await act(async () => document.documentElement.style.setProperty('--foreground', '#ffffff'));
  expect(mermaid.render).toHaveBeenCalledTimes(3);
  expect(mermaid.initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      themeVariables: expect.objectContaining({
        primaryColor: '#fedcba',
        primaryTextColor: '#ffffff',
      }),
    })
  );
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

it('measures diagrams at the visible container width', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(720);
  vi.mocked(mermaid.render).mockImplementationOnce((_id, _chart, target) => {
    expect(target?.getAttribute('style')).toContain('width: 720px');
    return Promise.resolve({ svg: '<svg></svg>', diagramType: 'gantt' });
  });
  await act(async () => root.render(<MermaidDiagram chart="gantt" />));
  expect(container.textContent).not.toContain('Error rendering diagram');
});

it('keeps an existing error visible until an appearance retry succeeds', async () => {
  const retry = deferredRender();
  vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('Incomplete diagram'));
  await act(async () => root.render(<MermaidDiagram chart="graph" />));
  vi.mocked(mermaid.render).mockImplementationOnce(() =>
    retry.promise.then((result) => ({ ...result, diagramType: 'flowchart' }))
  );
  await act(async () => document.documentElement.setAttribute('data-color-scheme', 'github'));
  expect(container.textContent).toContain('Incomplete diagram');
  expect(container.firstElementChild?.hasAttribute('hidden')).toBe(true);
  await act(async () => retry.resolve({ svg: '<svg aria-label="Retried diagram"></svg>' }));
  expect(container.textContent).not.toContain('Incomplete diagram');
  expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Retried diagram');
});
