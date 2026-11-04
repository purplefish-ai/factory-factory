// @vitest-environment jsdom

import { QueryClient, QueryObserver, type RefetchOptions } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectsListPage from './list';

const mocks = vi.hoisted(() => ({
  archiveMutationOptions: undefined as
    | {
        onSuccess?: () => void;
        onError?: (error: Error) => void;
      }
    | undefined,
  archiveMutate: vi.fn(),
  archivePending: false,
  refetch: vi.fn<(options?: RefetchOptions) => Promise<unknown>>(),
  toastError: vi.fn(),
  listError: null as Error | null,
  listFetching: false,
  listData: undefined as unknown[] | undefined,
}));

const ALPHA_PROJECT = {
  id: 'project-1',
  name: 'Alpha',
  slug: 'alpha',
  repoPath: '/repos/alpha',
  defaultBranch: 'main',
  startupScriptCommand: null,
  startupScriptPath: null,
  _count: { workspaces: 2 },
};

vi.mock('@phosphor-icons/react/dist/csr/Archive', () => ({
  ArchiveIcon: () => createElement('span', { 'data-testid': 'archive-icon' }),
}));
vi.mock('@phosphor-icons/react/dist/csr/Plus', () => ({ PlusIcon: () => null }));

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

vi.mock('@/client/components/app-header-context', () => ({
  useAppHeader: vi.fn(),
}));

vi.mock('@phosphor-icons/react/dist/csr/ArrowClockwise', () => ({
  ArrowClockwiseIcon: () => null,
}));
vi.mock('@phosphor-icons/react/dist/csr/WarningCircle', () => ({
  WarningCircleIcon: () => null,
}));

vi.mock('@/client/features/project/project-settings-dialog', () => ({
  ProjectSettingsDialog: () => null,
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    project: {
      list: {
        useQuery: () => ({
          data: mocks.listData,
          isLoading: false,
          error: mocks.listError,
          isFetching: mocks.listFetching,
          refetch: mocks.refetch,
        }),
      },
      archive: {
        useMutation: (
          options: { onSuccess?: () => void; onError?: (error: Error) => void } = {}
        ) => {
          mocks.archiveMutationOptions = options;
          return {
            mutate: mocks.archiveMutate,
            get isPending() {
              return mocks.archivePending;
            },
          };
        },
      },
    },
  },
}));

vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({
    asChild: _asChild,
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) =>
    createElement('button', props, children),
}));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    onOpenChange,
    onConfirm,
    isPending,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    isPending?: boolean;
  }) =>
    open
      ? createElement(
          'div',
          { role: 'dialog' },
          createElement(
            'button',
            {
              type: 'button',
              onClick: onConfirm,
              disabled: isPending,
            },
            isPending ? 'Archiving' : 'Archive'
          ),
          createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'dismiss-dialog',
              onClick: () => onOpenChange(false),
            },
            'Dismiss'
          )
        )
      : null,
}));

vi.mock('@/components/ui/spinner', () => ({
  Spinner: () => createElement('span', { 'aria-label': 'Loading' }),
}));

vi.mock('@/components/ui/table', () => ({
  Table: ({ children }: { children: ReactNode }) => createElement('table', null, children),
  TableBody: ({ children }: { children: ReactNode }) => createElement('tbody', null, children),
  TableCell: ({ children }: { children: ReactNode }) => createElement('td', null, children),
  TableHead: ({ children }: { children?: ReactNode }) => createElement('th', null, children),
  TableHeader: ({ children }: { children: ReactNode }) => createElement('thead', null, children),
  TableRow: ({ children }: { children: ReactNode }) => createElement('tr', null, children),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TooltipContent: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

function renderPage(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(createElement(ProjectsListPage));
  });

  return { container, root };
}

function click(element: Element | null): void {
  if (!element) {
    throw new Error('Expected element to exist');
  }

  flushSync(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function openArchiveDialog(container: HTMLDivElement): void {
  click(container.querySelector('[data-testid="archive-icon"]')?.closest('button') ?? null);
}

beforeEach(() => {
  mocks.archiveMutationOptions = undefined;
  mocks.archiveMutate.mockReset();
  mocks.archivePending = false;
  mocks.refetch.mockReset();
  mocks.toastError.mockReset();
  mocks.listError = null;
  mocks.listFetching = false;
  mocks.listData = [ALPHA_PROJECT];
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ProjectsListPage archive confirmation', () => {
  it('reports a failed post-archive refresh using the real query refetch contract', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      queryKey: ['post-archive-refresh'],
      enabled: false,
      queryFn: () => Promise.reject(new Error('Refresh failed')),
    });
    mocks.refetch.mockImplementation(observer.refetch);
    const { root } = renderPage();
    try {
      flushSync(() => mocks.archiveMutationOptions?.onSuccess?.());
      await vi.waitFor(() => {
        expect(mocks.toastError).toHaveBeenCalledWith(
          "Couldn't refresh data",
          expect.objectContaining({ description: 'Refresh failed' })
        );
      });
    } finally {
      flushSync(() => root.unmount());
      client.clear();
    }
  });

  it('keeps the dialog open while archiving and after a failed archive', () => {
    const { container, root } = renderPage();
    openArchiveDialog(container);

    click(container.querySelector('[role="dialog"] button'));

    expect(mocks.archiveMutate).toHaveBeenCalledWith({ id: 'project-1' });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    mocks.archivePending = true;
    flushSync(() => {
      root.render(createElement(ProjectsListPage));
    });

    const pendingButton = container.querySelector<HTMLButtonElement>('[role="dialog"] button');
    expect(pendingButton?.disabled).toBe(true);
    expect(pendingButton?.textContent).toBe('Archiving');

    flushSync(() => {
      mocks.archiveMutationOptions?.onError?.(new Error('Archive failed'));
    });

    expect(mocks.toastError).toHaveBeenCalledWith('Archive failed');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    root.unmount();
  });

  it('uses a fallback toast when an archive error has no message', () => {
    const { root } = renderPage();

    mocks.archiveMutationOptions?.onError?.(new Error(''));

    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't archive project");

    root.unmount();
  });

  it('prevents the archive dialog from being dismissed while pending', () => {
    const { container, root } = renderPage();
    openArchiveDialog(container);

    mocks.archivePending = true;
    flushSync(() => {
      root.render(createElement(ProjectsListPage));
    });

    click(container.querySelector('[data-testid="dismiss-dialog"]'));

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    root.unmount();
  });

  it('closes the dialog and refreshes projects only after archive success', () => {
    const { container, root } = renderPage();
    openArchiveDialog(container);

    flushSync(() => {
      mocks.archiveMutationOptions?.onSuccess?.();
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.refetch).toHaveBeenCalledOnce();

    root.unmount();
  });
});

describe('ProjectsListPage load failure', () => {
  it('shows the error with Retry instead of the first-run empty state', () => {
    mocks.listData = undefined;
    mocks.listError = new Error('Backend unavailable');
    mocks.refetch.mockResolvedValue(undefined);
    const { container, root } = renderPage();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn't load projects");
    expect(alert?.textContent).toContain('Backend unavailable');
    expect(container.textContent).not.toContain('No projects yet');
    expect(container.textContent).not.toContain('Create your first project');

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    );
    click(retry ?? null);
    expect(mocks.refetch).toHaveBeenCalledOnce();

    root.unmount();
  });

  it('disables Retry while the retry is in flight', () => {
    mocks.listData = undefined;
    mocks.listError = new Error('Backend unavailable');
    mocks.listFetching = true;
    const { container, root } = renderPage();

    const retry = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retrying')
    );
    expect(retry?.disabled).toBe(true);

    root.unmount();
  });

  it('keeps showing cached projects when a background refetch fails', () => {
    mocks.listError = new Error('Backend unavailable');
    const { container, root } = renderPage();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Alpha');

    root.unmount();
  });

  it('still shows the empty state when the project list is genuinely empty', () => {
    mocks.listData = [];
    const { container, root } = renderPage();

    expect(container.textContent).toContain('No projects yet');
    expect(container.querySelector('[role="alert"]')).toBeNull();

    root.unmount();
  });
});
