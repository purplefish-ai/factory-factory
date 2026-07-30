// @vitest-environment jsdom

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
  refetch: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@phosphor-icons/react', () => ({
  ArchiveIcon: () => createElement('span', { 'data-testid': 'archive-icon' }),
  PlusIcon: () => null,
}));

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

vi.mock('@/client/features/project/project-settings-dialog', () => ({
  ProjectSettingsDialog: () => null,
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    project: {
      list: {
        useQuery: () => ({
          data: [
            {
              id: 'project-1',
              name: 'Alpha',
              slug: 'alpha',
              repoPath: '/repos/alpha',
              defaultBranch: 'main',
              startupScriptCommand: null,
              startupScriptPath: null,
              _count: { workspaces: 2 },
            },
          ],
          isLoading: false,
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
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ProjectsListPage archive confirmation', () => {
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

    expect(mocks.toastError).toHaveBeenCalledWith('Failed to archive project');

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
