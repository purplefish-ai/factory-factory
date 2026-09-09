// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffViewer } from './diff-viewer';

const query = vi.hoisted(() => ({ diff: '', theme: 'dark' }));
vi.mock('./workspace-panel-context', () => ({
  useWorkspacePanel: () => ({ getScrollState: () => null, setScrollState: () => undefined }),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: { workspace: { getFileDiff: { useQuery: () => ({ data: { diff: query.diff } }) } } },
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: query.theme }) }));
vi.mock('./use-persistent-scroll', () => ({
  usePersistentScroll: () => ({ handleScroll: () => undefined }),
}));

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  request: unknown;
  constructor() {
    TestWorker.instances.push(this);
  }
  postMessage(request: unknown) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Worker', TestWorker);
  TestWorker.instances = [];
  query.theme = 'dark';
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-index') ? 16 : 320;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(640);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {
        /* Layout is supplied by the element size spies. */
      }
      unobserve() {
        /* Layout is supplied by the element size spies. */
      }
      disconnect() {
        /* Layout is supplied by the element size spies. */
      }
    }
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(filePath = 'example.ts') {
  await act(() => root.render(<DiffViewer workspaceId="w1" filePath={filePath} tabId="diff-1" />));
}

function makeDiff(count: number) {
  return `@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, i) => `+const value${i} = true;`).join('\n')}`;
}

describe('DiffViewer performance', () => {
  it('renders a bounded window of a large diff and reaches later lines on scroll', async () => {
    query.diff = makeDiff(10_000);
    await render();
    expect(container.textContent).toContain('const value0 = true;');
    expect(container.querySelectorAll('pre').length).toBeLessThan(100);
    expect(container.textContent).not.toContain('const value9999 = true;');
    const viewport = container.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    await act(() => {
      if (viewport) {
        viewport.scrollTop = 8000;
        viewport.dispatchEvent(new Event('scroll'));
      }
    });
    expect(container.textContent).toContain('const value500 = true;');
    expect(container.querySelectorAll('pre').length).toBeLessThan(100);
  });

  it('shows plain text while highlighting in a worker and rejects stale results', async () => {
    query.diff = makeDiff(2);
    await render();
    expect(container.textContent).toContain('const value0 = true;');
    const first = TestWorker.instances.at(-1);
    expect(first).toBeDefined();
    query.diff = '@@ -0,0 +1,1 @@\n+const changed = false;';
    await render();
    expect(first?.terminated).toBe(true);
    await act(() =>
      first?.reply(new Map([[1, [{ content: 'STALE CONTENT', style: { color: 'red' } }]]]))
    );
    expect(container.textContent).not.toContain('STALE CONTENT');
    const current = TestWorker.instances.at(-1);
    await act(() =>
      current?.reply(
        new Map([
          [
            1,
            [{ content: 'const changed = false;', style: { color: 'red', fontStyle: undefined } }],
          ],
        ])
      )
    );
    expect(container.querySelector('pre span')?.getAttribute('style')).toContain('color: red');
  });

  it('discards old-theme highlights and terminates workers on failure and unmount', async () => {
    query.diff = makeDiff(2);
    await render();
    const darkWorker = TestWorker.instances.at(-1);
    await act(() =>
      darkWorker?.reply(
        new Map([[1, [{ content: 'const value0 = true;', style: { color: 'red' } }]]])
      )
    );
    expect(container.querySelector('pre span')?.getAttribute('style')).toContain('color: red');
    query.theme = 'light';
    await render();
    expect(container.querySelector('pre span')).toBeNull();
    const lightWorker = TestWorker.instances.at(-1);
    await act(() => lightWorker?.onerror?.());
    expect(lightWorker?.terminated).toBe(true);
    expect(container.textContent).toContain('const value0 = true;');
    query.diff = makeDiff(3);
    await render();
    const lastWorker = TestWorker.instances.at(-1);
    await act(() => root.render(null));
    expect(lastWorker?.terminated).toBe(true);
  });

  it('ignores malformed worker replies without losing the visible diff', async () => {
    query.diff = makeDiff(2);
    await render();
    await act(() => TestWorker.instances.at(-1)?.reply({ invalid: true }));
    expect(container.textContent).toContain('const value0 = true;');
    expect(container.querySelector('pre span')).toBeNull();
  });

  it('keeps the diff readable when a worker is unavailable or fails', async () => {
    query.diff = makeDiff(2);
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Workers unavailable');
        }
      }
    );
    await render();
    expect(container.textContent).toContain('const value0 = true;');
  });
});
