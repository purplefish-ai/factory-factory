// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MainViewContent } from './main-view-content';

vi.mock('./workspace-panel-context', () => ({
  useWorkspacePanel: () => ({
    tabs: [{ id: 'file1', type: 'file', path: 'example.ts' }],
    activeTabId: 'file1',
  }),
}));
vi.mock('./file-viewer', () => {
  throw new Error('Failed to fetch viewer chunk');
});

it('contains a rejected viewer chunk while retaining the mounted chat', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('reportError', vi.fn());
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container, {
    onCaughtError: () => undefined,
    onUncaughtError: () => undefined,
  });
  try {
    await act(() =>
      root.render(
        <MainViewContent workspaceId="workspace">
          <div data-testid="chat">Chat state</div>
        </MainViewContent>
      )
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Unable to load viewer'
      )
    );
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toBe('Chat state');
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
