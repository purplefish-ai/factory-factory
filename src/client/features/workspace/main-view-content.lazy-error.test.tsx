// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MainViewContent } from './main-view-content';

vi.mock('./workspace-panel-context', () => ({
  useWorkspacePanel: () => ({
    tabs: [{ id: 'file1', type: 'file', path: 'example.ts' }],
    activeTabId: 'file1',
  }),
}));
const chunk = vi.hoisted(() => {
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
});
vi.mock('./file-viewer', () => chunk.promise);

function StatefulChat({ mounted, unmounted }: { mounted: () => void; unmounted: () => void }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    mounted();
    return () => unmounted();
  }, [mounted, unmounted]);
  return (
    <button type="button" data-testid="chat" onClick={() => setCount((value) => value + 1)}>
      Chat state {count}
    </button>
  );
}

it('contains a rejected viewer chunk while retaining the mounted chat', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('reportError', vi.fn());
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container, {
    onCaughtError: () => undefined,
    onUncaughtError: () => undefined,
  });
  const mounted = vi.fn();
  const unmounted = vi.fn();
  try {
    await act(() =>
      root.render(
        <MainViewContent workspaceId="workspace">
          <StatefulChat mounted={mounted} unmounted={unmounted} />
        </MainViewContent>
      )
    );
    const chat = container.querySelector('[data-testid="chat"]');
    expect(mounted).toHaveBeenCalledTimes(1);
    await act(() => {
      chat?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(chat?.textContent).toBe('Chat state 1');
    await act(() => chunk.reject(new Error('Failed to fetch viewer chunk')));
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Unable to load viewer'
      )
    );
    expect(container.querySelector('[data-testid="chat"]')).toBe(chat);
    expect(chat?.textContent).toBe('Chat state 1');
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
