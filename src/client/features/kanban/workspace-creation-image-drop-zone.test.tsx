// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceCreationImageDropZone } from './workspace-creation-image-drop-zone';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('preserves the sidebar subtree and scroll position when the selected project becomes unavailable', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (projectId: string | undefined) =>
    act(() =>
      root.render(
        <WorkspaceCreationImageDropZone projectId={projectId} onDropAccepted={() => undefined}>
          <div data-scroll>
            <input defaultValue="Local child state" />
          </div>
        </WorkspaceCreationImageDropZone>
      )
    );
  try {
    await render('sidebar-project');
    const scroll = container.querySelector<HTMLDivElement>('[data-scroll]')!;
    const input = container.querySelector('input')!;
    scroll.scrollTop = 100;
    input.value = 'Edited child state';
    await render(undefined);
    await render('sidebar-project');
    expect(container.querySelector('[data-scroll]')).toBe(scroll);
    expect(scroll.scrollTop).toBe(100);
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('Edited child state');
  } finally {
    await act(() => root.unmount());
  }
});
