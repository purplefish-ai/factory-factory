// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScreenshotsPanel } from './screenshots-panel';

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  onTakeScreenshots: vi.fn(),
}));

vi.mock('@phosphor-icons/react', () => ({
  CameraIcon: () => null,
  SpinnerGapIcon: () => null,
  XIcon: () => null,
}));

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
        useMutation: () => ({ mutate: vi.fn() }),
      },
      listScreenshots: {
        useQuery: () => ({
          data: { screenshots: [] },
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
  vi.clearAllMocks();
});

describe('ScreenshotsPanel', () => {
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
