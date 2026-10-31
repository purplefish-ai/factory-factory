// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenshotsPanel } from './screenshots-panel';

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  deleteScreenshot: vi.fn(),
  screenshots: [] as { name: string; path: string; size: number }[],
  onTakeScreenshots: vi.fn(),
}));

vi.mock('@phosphor-icons/react/dist/csr/Camera', () => ({ CameraIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/SpinnerGap', () => ({ SpinnerGapIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/X', () => ({ XIcon: () => null }));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) =>
    createElement('button', { onClick, type: 'button' }, children),
}));

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        listScreenshots: {
          invalidate: vi.fn(),
        },
      },
    }),
    workspace: {
      deleteScreenshot: {
        useMutation: () => ({ mutate: mocks.deleteScreenshot }),
      },
      listScreenshots: {
        useQuery: () => ({
          data: { screenshots: mocks.screenshots },
          isLoading: false,
        }),
      },
      readScreenshot: {
        useQuery: () => ({ data: undefined, isLoading: false }),
      },
    },
  },
}));

vi.mock('./workspace-panel-context', () => ({
  useWorkspacePanel: () => ({ openTab: mocks.openTab }),
}));

afterEach(() => {
  document.body.innerHTML = '';
  mocks.screenshots = [];
  vi.clearAllMocks();
});

describe('ScreenshotsPanel', () => {
  it('keeps delete and open as independent screenshot actions', () => {
    mocks.screenshots = [{ name: 'Home', path: 'home.png', size: 1 }];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() =>
      root.render(
        createElement(ScreenshotsPanel, {
          workspaceId: 'workspace-1',
          isTakingScreenshots: false,
        })
      )
    );
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete screenshot Home"]'
    );
    const open = container.querySelector<HTMLButtonElement>('[aria-label="Open screenshot Home"]');
    expect(remove).not.toBeNull();
    expect(open).not.toBeNull();
    expect(container.querySelector('button button')).toBeNull();
    flushSync(() => remove?.click());
    expect(mocks.deleteScreenshot).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      path: 'home.png',
    });
    expect(mocks.openTab).not.toHaveBeenCalled();
    flushSync(() => open?.click());
    expect(mocks.openTab).toHaveBeenCalledWith('screenshot', 'home.png', 'Home');
    flushSync(() => root.unmount());
  });

  it('shows the retry action again when its controlled loading state clears', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        createElement(ScreenshotsPanel, {
          workspaceId: 'workspace-1',
          isTakingScreenshots: true,
          onTakeScreenshots: mocks.onTakeScreenshots,
        })
      );
    });

    expect(container.textContent).toContain('Taking Screenshots...');
    expect(container.querySelector('button')).toBeNull();

    flushSync(() => {
      root.render(
        createElement(ScreenshotsPanel, {
          workspaceId: 'workspace-1',
          isTakingScreenshots: false,
          onTakeScreenshots: mocks.onTakeScreenshots,
        })
      );
    });

    const retryButton = container.querySelector('button');
    expect(retryButton?.textContent).toContain('Take Screenshots');

    retryButton?.click();
    expect(mocks.onTakeScreenshots).toHaveBeenCalledOnce();

    root.unmount();
  });
});
