// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppNavigationDataProvider,
  useAppNavigationData,
} from '@/client/hooks/use-app-navigation-data';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import NewProjectPage from './new';

const { listProjects } = vi.hoisted(() => ({ listProjects: vi.fn() }));
const projects = [
  { id: 'alpha-id', slug: 'alpha', name: 'Alpha' },
  { id: 'beta-id', slug: 'beta', name: 'Beta' },
];

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ project: { list: { invalidate: vi.fn() } } }),
    project: {
      list: {
        useQuery: () => useQuery({ queryKey: ['projects'], queryFn: listProjects }),
      },
      checkFactoryConfig: { useQuery: () => ({ data: undefined }) },
      checkGithubAuth: { useQuery: () => ({ data: undefined, refetch: vi.fn() }) },
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      createFromGithub: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    workspace: {
      listForProject: { useQuery: () => ({ data: undefined }) },
      syncAllPRStatuses: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));
vi.mock('@/client/hooks/use-project-snapshot-sync', () => ({ useProjectSnapshotSync: vi.fn() }));
vi.mock('@/client/hooks/use-cli-health-refresh', () => ({
  useCLIHealthRefresh: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/client/components/app-header-context', () => ({
  useAppHeader: vi.fn(),
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/client/components/project-selector', () => ({
  ProjectSelectorDropdown: ({
    onCurrentProjectSelect,
    selectedProjectSlug,
  }: {
    onCurrentProjectSelect: () => void;
    selectedProjectSlug: string;
  }) => createElement('button', { onClick: onCurrentProjectSelect }, selectedProjectSlug),
}));
vi.mock('@/client/features/project/onboarding-cli-health', () => ({
  OnboardingCliHealth: () => null,
}));
vi.mock('@/client/features/project/github-url-form', () => ({
  GithubUrlForm: ({ footerActions }: { footerActions?: ReactNode }) =>
    createElement(
      'div',
      null,
      createElement('input', { 'aria-label': 'GitHub URL' }),
      footerActions
    ),
}));
vi.mock('@/client/features/project/startup-script-form', () => ({ StartupScriptForm: () => null }));
vi.mock('@/client/features/project/setup-terminal-modal', () => ({
  SetupTerminalModal: () => null,
}));
vi.mock('@/client/features/data-import/data-import-button', () => ({
  DataImportButton: ({ children }: { children: ReactNode }) =>
    createElement('button', null, children),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const cleanups: Array<() => void> = [];
function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Layout() {
    const navigation = useAppNavigationData();
    const { pathname } = useLocation();
    return (
      <AppNavigationDataProvider value={navigation}>
        <div data-testid="location">{pathname}</div>
        <Link data-testid="leave-page" to="/projects/beta/workspaces">
          Leave page
        </Link>
        <Routes>
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/projects" element={<div>Projects page</div>} />
          <Route path="/projects/:slug/workspaces" element={<div>Workspace board</div>} />
        </Routes>
      </AppNavigationDataProvider>
    );
  }
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/projects/new']}>
          <Layout />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  cleanups.push(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  });
  const button = (text: string) =>
    Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === text);
  const click = (element: Element | undefined | null) => {
    expect(element).toBeTruthy();
    act(() => {
      element?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };
  return { container, client, button, click };
}

async function waitFor(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  localStorage.setItem(SELECTED_PROJECT_KEY, 'beta');
  listProjects.mockReset();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  localStorage.clear();
});

describe('NewProjectPage project query recovery', () => {
  it('replaces a terminal initial failure with an accessible error and retry', async () => {
    listProjects.mockRejectedValue(new Error('Backend unavailable'));
    const { container, button } = renderPage();
    await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain('Unable to load projects');
    expect(container.textContent).toContain('Backend unavailable');
    expect(container.textContent).not.toContain('Loading projects');
    expect(container.textContent).not.toContain('Get Started');
    expect(button('Retry')).toBeDefined();
    expect(container.querySelector('a[href="/projects"]')?.textContent).toBe('Back to Projects');
  });

  it.each([{ result: [] }, { result: projects }])(
    'recovers to the appropriate form after retry: $result',
    async ({ result }) => {
      listProjects.mockRejectedValueOnce(new Error('Backend unavailable'));
      const retry = deferred<typeof projects>();
      listProjects.mockImplementationOnce(() => retry.promise);
      const { container, button, click } = renderPage();
      await waitFor(() => expect(button('Retry')).toBeDefined());
      click(button('Retry'));
      await waitFor(() => expect(container.textContent).toContain('Loading projects'));
      expect(button('Retry')).toBeUndefined();
      expect(container.textContent).not.toContain('Get Started');
      await act(async () => retry.resolve(result));
      await waitFor(() =>
        expect(container.querySelector('input[aria-label="GitHub URL"]')).not.toBeNull()
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain(result.length ? 'Add Project' : 'Get Started');
      if (result.length) {
        expect(
          container.querySelector(
            'a[href="/projects/beta/workspaces"]:not([data-testid="leave-page"])'
          )?.textContent
        ).toBe('Cancel');
      } else {
        expect(button('Import from Backup')).toBeDefined();
      }
    }
  );

  it('allows another retry after a retry fails', async () => {
    listProjects.mockRejectedValue(new Error('Still unavailable'));
    const { container, button, click } = renderPage();
    await waitFor(() => expect(button('Retry')).toBeDefined());
    click(button('Retry'));
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button('Retry')?.disabled).toBe(false));
    expect(container.textContent).toContain('Still unavailable');
    listProjects.mockResolvedValue([]);
    click(button('Retry'));
    await waitFor(() => expect(container.textContent).toContain('Get Started'));
  });

  it('waits on a genuinely pending query without flashing onboarding', async () => {
    const pending = deferred<typeof projects>();
    listProjects.mockReturnValue(pending.promise);
    const { container } = renderPage();
    expect(container.textContent).toContain('Loading projects');
    expect(container.textContent).not.toContain('Get Started');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => pending.resolve(projects));
    await waitFor(() => expect(container.textContent).toContain('Add Project'));
    expect(container.textContent).not.toContain('Get Started');
  });

  it('keeps cached projects and form input during a background failure', async () => {
    listProjects.mockResolvedValueOnce(projects).mockRejectedValue(new Error('Refetch failed'));
    const { container, client, click, button } = renderPage();
    await waitFor(() => expect(container.textContent).toContain('Add Project'));
    click(button('Local Path'));
    const input = container.querySelector<HTMLInputElement>('input[id="repoPath"]');
    expect(input).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        '/repo/draft'
      );
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await client.refetchQueries({ queryKey: ['projects'] });
    });
    expect(client.getQueryState(['projects'])?.status).toBe('error');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Loading projects');
    expect(container.querySelector<HTMLInputElement>('input[id="repoPath"]')?.value).toBe(
      '/repo/draft'
    );
    expect(
      container.querySelector('a[href="/projects/beta/workspaces"]:not([data-testid="leave-page"])')
        ?.textContent
    ).toBe('Cancel');
    click(button('beta'));
    await waitFor(() => expect(container.textContent).toContain('Workspace board'));
  });

  it.each(['resolve', 'reject'] as const)(
    'does not navigate back after leaving a pending retry (%s)',
    async (settle) => {
      const retry = deferred<typeof projects>();
      listProjects
        .mockRejectedValueOnce(new Error('Unavailable'))
        .mockReturnValueOnce(retry.promise);
      const { container, client, button, click } = renderPage();
      await waitFor(() => expect(button('Retry')).toBeDefined());
      click(button('Retry'));
      await waitFor(() => expect(container.textContent).toContain('Loading projects'));
      expect(button('Retry')).toBeUndefined();
      click(container.querySelector('a[href="/projects/beta/workspaces"]'));
      await waitFor(() => expect(container.textContent).toContain('Workspace board'));
      await act(async () => {
        if (settle === 'resolve') {
          retry.resolve(projects);
        } else {
          retry.reject(new Error('Late failure'));
        }
        await retry.promise.catch(() => undefined);
      });
      await waitFor(() =>
        expect(client.getQueryState(['projects'])?.status).toBe(
          settle === 'resolve' ? 'success' : 'error'
        )
      );
      expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
        '/projects/beta/workspaces'
      );
      expect(container.textContent).not.toContain('Get Started');
    }
  );
});
