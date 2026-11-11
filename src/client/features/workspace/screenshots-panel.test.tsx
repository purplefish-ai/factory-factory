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
  deleteOptions: undefined as
    | { onSuccess?: () => void; onError?: (error: Error) => void }
    | undefined,
  deletePending: false,
  listError: null as Error | null,
  readError: null as Error | null,
  listHasData: true,
  listFetching: false,
  refetch: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@phosphor-icons/react/dist/csr/ArrowClockwise', () => ({
  ArrowClockwiseIcon: () => null,
}));
vi.mock('@phosphor-icons/react/dist/csr/WarningCircle', () => ({
  WarningCircleIcon: () => null,
}));
vi.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmText,
    onOpenChange,
    onConfirm,
    isPending,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmText: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    isPending?: boolean;
  }) =>
    open
      ? createElement(
          'div',
          { role: 'alertdialog', 'aria-label': title },
          createElement('p', null, description),
          createElement(
            'button',
            { type: 'button', 'data-testid': 'confirm', onClick: onConfirm, disabled: isPending },
            confirmText
          ),
          createElement(
            'button',
            // Like the real dialog, which disables Cancel and ignores close
            // requests while pending (src/components/ui/pending-controls.test.tsx).
            {
              type: 'button',
              'data-testid': 'cancel',
              onClick: () => onOpenChange(false),
              disabled: isPending,
            },
            'Cancel'
          )
        )
      : null,
}));

vi.mock('@phosphor-icons/react/dist/csr/Camera', () => ({ CameraIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/SpinnerGap', () => ({ SpinnerGapIcon: () => null }));
vi.mock('@phosphor-icons/react/dist/csr/X', () => ({ XIcon: () => null }));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => createElement('button', { onClick, disabled, type: 'button' }, children),
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
        useMutation: (options: typeof mocks.deleteOptions) => {
          mocks.deleteOptions = options;
          return { mutate: mocks.deleteScreenshot, isPending: mocks.deletePending };
        },
      },
      listScreenshots: {
        useQuery: () => ({
          data: mocks.listHasData ? { screenshots: mocks.screenshots } : undefined,
          isLoading: false,
          error: mocks.listError,
          isFetching: mocks.listFetching,
          refetch: mocks.refetch,
        }),
      },
      readScreenshot: {
        useQuery: () => ({ data: undefined, isLoading: false, error: mocks.readError }),
      },
    },
  },
}));

vi.mock('./workspace-panel-context', () => ({
  useWorkspacePanelActions: () => ({ openTab: mocks.openTab }),
}));

afterEach(() => {
  document.body.innerHTML = '';
  mocks.screenshots = [];
  mocks.deleteOptions = undefined;
  mocks.deletePending = false;
  mocks.listError = null;
  mocks.readError = null;
  mocks.listHasData = true;
  mocks.listFetching = false;
  vi.clearAllMocks();
});

function renderPanel(props: Partial<Parameters<typeof ScreenshotsPanel>[0]> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () =>
    flushSync(() =>
      root.render(
        createElement(ScreenshotsPanel, {
          workspaceId: 'workspace-1',
          isTakingScreenshots: false,
          ...props,
        })
      )
    );
  render();
  return { container, root, rerender: render };
}

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
    // Delete is confirmed first (#2941); confirming issues the mutation.
    expect(mocks.deleteScreenshot).not.toHaveBeenCalled();
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="confirm"]')?.click());
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

    expect(container.textContent).toContain('Taking screenshots…');
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
    expect(retryButton?.textContent).toContain('Take screenshots');

    retryButton?.click();
    expect(mocks.onTakeScreenshots).toHaveBeenCalledOnce();

    root.unmount();
  });

  it('confirms before deleting and keeps the dialog open after a failure', () => {
    mocks.screenshots = [{ name: 'home.png', path: 'home.png', size: 1 }];
    const { container, root, rerender } = renderPanel();

    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Delete screenshot home.png"]')
        ?.click()
    );
    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('Delete screenshot?');
    expect(dialog?.textContent).toContain('"home.png" will be permanently deleted');

    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="cancel"]')?.click());
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mocks.deleteScreenshot).not.toHaveBeenCalled();

    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Delete screenshot home.png"]')
        ?.click()
    );
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="confirm"]')?.click());
    expect(mocks.deleteScreenshot).toHaveBeenCalledOnce();

    mocks.deletePending = true;
    rerender();
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="cancel"]')?.click());
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    mocks.deletePending = false;
    flushSync(() => mocks.deleteOptions?.onError?.(new Error('EACCES: permission denied')));
    rerender();
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't delete screenshot.", {
      description: 'EACCES: permission denied',
    });
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    flushSync(() => mocks.deleteOptions?.onSuccess?.());
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();

    flushSync(() => root.unmount());
  });

  it('shows the load error with Retry instead of the empty state', () => {
    mocks.listHasData = false;
    mocks.listError = new Error('Workspace not found');
    const { container, root } = renderPanel({ onTakeScreenshots: mocks.onTakeScreenshots });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load screenshots");
    expect(alert?.textContent).toContain('Workspace not found');
    expect(container.textContent).not.toContain('No screenshots yet');

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    );
    flushSync(() => retry?.click());
    expect(mocks.refetch).toHaveBeenCalledOnce();

    flushSync(() => root.unmount());
  });

  it('keeps cached screenshots visible when a background refetch fails', () => {
    mocks.screenshots = [{ name: 'home.png', path: 'home.png', size: 1 }];
    mocks.listError = new Error('Background refresh failed');
    mocks.listFetching = true;
    const { container, root } = renderPanel();

    expect(container.querySelector('[aria-label="Open screenshot home.png"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("Couldn't load screenshots");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Couldn't refresh");

    flushSync(() => root.unmount());
  });

  it('marks a thumbnail whose image failed to load instead of leaving it blank', () => {
    mocks.screenshots = [{ name: 'home.png', path: 'home.png', size: 1 }];
    mocks.readError = new Error('ENOENT');
    const { container, root } = renderPanel();

    const thumbnail = container.querySelector('[aria-label="Open screenshot home.png"]');
    expect(thumbnail?.textContent).toContain("Couldn't load preview");
    expect(thumbnail?.querySelector('[title="ENOENT"]')).not.toBeNull();

    flushSync(() => root.unmount());
  });

  it('closes the delete confirmation when its screenshot leaves the list', async () => {
    mocks.screenshots = [{ name: 'home.png', path: 'home.png', size: 1 }];
    const { container, root, rerender } = renderPanel();

    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Delete screenshot home.png"]')
        ?.click()
    );
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    mocks.screenshots = [];
    rerender();
    await vi.waitFor(() => expect(container.querySelector('[role="alertdialog"]')).toBeNull());

    // A screenshot reappearing must not reopen the stale confirmation.
    mocks.screenshots = [{ name: 'home.png', path: 'home.png', size: 1 }];
    rerender();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mocks.deleteScreenshot).not.toHaveBeenCalled();

    flushSync(() => root.unmount());
  });
});
