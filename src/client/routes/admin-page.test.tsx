// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import AdminDashboardPage from './admin-page';

const mocks = vi.hoisted(() => ({
  statsError: null as Error | null,
  unresolvedDiagnostics: false,
  statsQuery: vi.fn(),
  processesQuery: vi.fn(),
  processesError: null as Error | null,
  projectsError: null as Error | null,
  refetchStats: vi.fn(),
  refetchProcesses: vi.fn(),
  refetchProjects: vi.fn(),
  resetMutationOptions: undefined as { onError?: (error: Error) => void } | undefined,
  toastError: vi.fn(),
}));

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

vi.mock('@/client/features/slack', () => ({
  SlackSettings: () => createElement('section', null, 'Slack'),
}));

vi.mock('@/client/features/codex-accounts', () => ({
  CodexAccountsSettings: () => createElement('section', null, 'Codex accounts'),
}));

vi.mock('@/client/components/app-header-context', () => ({
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  HeaderLeftExtraSlot: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  useAppHeader: vi.fn(),
}));

vi.mock('@/client/hooks/use-project-header-navigation', () => ({
  useProjectHeaderNavigation: () => ({
    projectsError: mocks.projectsError,
    refetchProjects: mocks.refetchProjects,
    selectedProjectSlug: 'alpha',
    projects: [{ id: 'project-1', slug: 'alpha', name: 'Alpha' }],
    handleProjectChange: vi.fn(),
    handleCurrentProjectSelect: vi.fn(),
  }),
}));

vi.mock('@/client/components/loading', () => ({
  Loading: ({ message }: { message: string }) => createElement('div', null, message),
}));

vi.mock('./admin/ProjectSettingsSection', () => ({
  ProjectSettingsSection: ({ project }: { project: { id: string; name: string } }) =>
    createElement(
      'section',
      { 'data-project': project.id },
      `${project.name} configuration`,
      createElement('input', { 'aria-label': `${project.name} draft`, defaultValue: '' })
    ),
}));
vi.mock('./admin/index', () => ({
  AdversarialReviewSection: () => createElement('section', null, 'Adversarial review'),
  ApiUsageSection: () => createElement('section', null, 'API usage'),
  AppearanceSettingsSection: () => createElement('section', null, 'Appearance Settings'),
  ProcessesSection: () => createElement('section', null, 'Processes'),
  ProcessesSectionSkeleton: () => createElement('section', null, 'Processes Loading'),
  VoiceModeSection: () => createElement('section', null, 'Voice Mode'),
  NotificationSettingsSection: () => createElement('section', null, 'Notification Settings'),
  ProjectSettingsSection: () => createElement('section', null, 'Factory Configuration'),
  AppInfoSection: () => createElement('section', null, 'App info'),
  ChatProviderDefaultsSection: () => createElement('section', null, 'Chat defaults'),
  TicketDispatchSettingsSection: () => createElement('section', null, 'Ticket dispatch prompt'),
  ChildWorkspaceSettingsSection: () => createElement('section', null, 'Child workspaces'),
  CliAuthSection: () => createElement('section', null, 'CLI Authentication'),
  DataBackupSection: () => createElement('section', null, 'Data Backup'),
  IdeSettingsSection: () => createElement('section', null, 'IDE settings'),
  RatchetSettingsSection: () => createElement('section', null, 'Ratchet Pull Requests'),
  ServerLogsSection: () => createElement('section', null, 'Server Logs'),
  WorktreeCleanupSection: () => createElement('section', null, 'Worktree Cleanup'),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    admin: {
      getSystemStats: {
        useQuery: () => {
          mocks.statsQuery();
          return {
            data:
              mocks.statsError || mocks.unresolvedDiagnostics
                ? undefined
                : { apiUsage: [], environment: 'test' },
            error: mocks.statsError,
            isLoading: false,
            isFetching: false,
            refetch: mocks.refetchStats,
          };
        },
      },
      getActiveProcesses: {
        useQuery: () => {
          mocks.processesQuery();
          return {
            data: mocks.processesError || mocks.unresolvedDiagnostics ? undefined : [],
            error: mocks.processesError,
            isLoading: false,
            isFetching: false,
            refetch: mocks.refetchProcesses,
          };
        },
      },
      resetApiUsageStats: {
        useMutation: (options: typeof mocks.resetMutationOptions) => {
          mocks.resetMutationOptions = options;
          return { mutateAsync: vi.fn(), isPending: false };
        },
      },
    },
    project: {
      list: {
        useQuery: () => ({
          error: mocks.projectsError,
          isFetching: false,
          refetch: mocks.refetchProjects,
          data: mocks.projectsError
            ? undefined
            : [
                {
                  id: 'project-1',
                  slug: 'alpha',
                  name: 'Alpha',
                  issueProvider: 'github',
                  issueTrackerConfig: null,
                },
                {
                  id: 'project-2',
                  slug: 'beta',
                  name: 'Beta',
                  issueProvider: 'github',
                  issueTrackerConfig: null,
                },
              ],
        }),
      },
    },
  },
}));
function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: createStorageStub(),
  });
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  mocks.statsError = null;
  mocks.unresolvedDiagnostics = false;
  mocks.processesError = null;
  mocks.projectsError = null;
  mocks.resetMutationOptions = undefined;
  vi.clearAllMocks();
});

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      Back
    </button>
  );
}
function renderAdmin(path = '/admin', initialEntries = [path]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries },
        createElement(BackButton),
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/admin/:section?',
            element: createElement(AdminDashboardPage),
          })
        )
      )
    );
  });
  return { container, root };
}

function clickButton(container: HTMLElement, label: string, index = 0) {
  const buttons = Array.from(container.querySelectorAll('button')).filter(
    (button) => button.textContent === label
  );
  flushSync(() => buttons[index]?.click());
}

describe('settings URL sections', () => {
  it('renders General immediately without mounting diagnostics polling', () => {
    const { container, root } = renderAdmin();
    expect(container.textContent).toContain('Notification Settings');
    expect(container.textContent).not.toContain('Processes');
    expect(container.textContent).not.toContain('Child workspaces');
    expect(mocks.statsQuery).not.toHaveBeenCalled();
    expect(mocks.processesQuery).not.toHaveBeenCalled();
    expect(container.querySelector('a[href="/admin/workspace"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/logs"]')).not.toBeNull();
    root.unmount();
  });

  it('recovers an unknown section to General', async () => {
    const { container, root } = renderAdmin('/admin/unknown');
    await act(async () => undefined);
    expect(container.textContent).toContain('Notification Settings');
    expect(container.querySelector('a[href="/admin"][aria-current="page"]')).not.toBeNull();
    root.unmount();
  });

  it('opens Workspace directly and navigates with a URL link', async () => {
    const { container, root } = renderAdmin('/admin/workspace');
    expect(container.textContent).toContain('Child workspaces');
    expect(container.textContent).toContain('Ticket dispatch prompt');
    expect(container.textContent).not.toContain('Notification Settings');
    const general = container.querySelector<HTMLAnchorElement>('a[href="/admin"]');
    await act(async () => general?.click());
    expect(container.textContent).toContain('Notification Settings');
    expect(container.textContent).not.toContain('Ticket dispatch prompt');
    root.unmount();
  });

  it('expands project settings inline without changing the selected project', async () => {
    localStorage.setItem(SELECTED_PROJECT_KEY, 'beta');
    const { container, root } = renderAdmin('/admin/project');
    expect(container.querySelector('[data-project]')).toBeNull();
    await act(() =>
      container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')?.click()
    );
    expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(
      'project-1'
    );
    expect(container.querySelector('button[aria-expanded="true"]')?.textContent).toBe('Alpha');
    expect(
      [...container.querySelectorAll('nav[aria-label="Breadcrumb"]')].filter(
        (nav) => !nav.closest('header')
      )
    ).toHaveLength(0);
    await act(() => clickButton(container, 'Beta'));
    expect(
      container
        .querySelector('[data-slot="collapsible-content"]:not([hidden]) [data-project]')
        ?.getAttribute('data-project')
    ).toBe('project-2');
    expect(
      container.querySelectorAll('[data-slot="collapsible-content"]:not([hidden]) [data-project]')
    ).toHaveLength(1);
    expect(localStorage.getItem(SELECTED_PROJECT_KEY)).toBe('beta');
    await act(() => clickButton(container, 'Beta'));
    expect(
      container.querySelector('[data-slot="collapsible-content"]:not([hidden]) [data-project]')
    ).toBeNull();
    root.unmount();
  });

  it('preserves project drafts across collapse, switching rows, and reselecting the active tab', async () => {
    const { container, root } = renderAdmin('/admin/project?project=alpha');
    try {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Alpha draft"]')!;
      input.value = 'unsaved Linear API key';
      const alpha = container.querySelector<HTMLButtonElement>(
        '[data-slot="collapsible-trigger"]'
      )!;
      await act(() => alpha.click());
      await act(() => alpha.click());
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="Alpha draft"]')?.value
      ).toBe('unsaved Linear API key');
      await act(() => clickButton(container, 'Beta'));
      await act(() => alpha.click());
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="Alpha draft"]')?.value
      ).toBe('unsaved Linear API key');
      await act(() =>
        container.querySelector<HTMLAnchorElement>('a[href^="/admin/project"]')?.click()
      );
      expect(alpha.getAttribute('aria-expanded')).toBe('true');
    } finally {
      root.unmount();
    }
  });

  it('does not add browser history entries for accordion changes', async () => {
    const { container, root } = renderAdmin('/admin/project', [
      '/admin/workspace',
      '/admin/project',
    ]);
    try {
      await act(() =>
        container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]')?.click()
      );
      await act(() => clickButton(container, 'Beta'));
      await act(() => clickButton(container, 'Back'));
      expect(container.textContent).toContain('Child workspaces');
    } finally {
      root.unmount();
    }
  });

  it('opens a linked project directly without falling back for unknown projects', () => {
    const { container, root } = renderAdmin('/admin/project?project=beta');
    expect(container.querySelector('[data-project]')?.getAttribute('data-project')).toBe(
      'project-2'
    );
    root.unmount();
    const unknown = renderAdmin('/admin/project?project=missing');
    expect(unknown.container.querySelector('[data-project]')).toBeNull();
    unknown.root.unmount();
  });

  it('keeps unresolved offline diagnostics loading without showing empty data', () => {
    mocks.unresolvedDiagnostics = true;
    const { container, root } = renderAdmin('/admin/system');
    expect(container.textContent).toContain('Loading API usage…');
    expect(container.textContent).toContain('Processes Loading');
    expect(container.textContent).not.toContain('Environment:');
    expect(container.textContent).not.toContain('unknown');
    expect(
      [...container.querySelectorAll('section')].some(
        (section) => section.textContent === 'API usage'
      )
    ).toBe(false);
    expect(
      [...container.querySelectorAll('section')].some(
        (section) => section.textContent === 'Processes'
      )
    ).toBe(false);
    root.unmount();
  });

  it('shows independent System failures with Retry while preserving navigation and maintenance', () => {
    mocks.statsError = new Error('Stats unavailable');
    mocks.processesError = new Error('Process list unavailable');
    const { container, root } = renderAdmin('/admin/system');
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      expect.stringContaining("Couldn't load API usage"),
      expect.stringContaining("Couldn't load active processes"),
    ]);
    expect(container.textContent).toContain('Data Backup');
    expect(container.querySelector('a[href="/admin/integrations"]')).not.toBeNull();
    clickButton(container, 'Retry', 0);
    expect(mocks.refetchStats).toHaveBeenCalledOnce();
    clickButton(container, 'Retry', 1);
    expect(mocks.refetchProcesses).toHaveBeenCalledOnce();
    root.unmount();
  });

  it('shows project-list errors with header and page retry instead of a false empty state', async () => {
    mocks.projectsError = new Error('Projects unavailable');
    const { container, root } = renderAdmin('/admin/project');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load projects"
    );
    expect(container.querySelector('header [role="alert"]')?.textContent).toContain(
      'Projects unavailable'
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    await act(() =>
      container
        .querySelector('[aria-label^="Open project menu"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    const retryItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'Retry projects'
    );
    expect(retryItem).toBeDefined();
    await act(() => retryItem?.click());
    expect(mocks.refetchProjects).toHaveBeenCalledOnce();
    clickButton(container, 'Retry');
    expect(mocks.refetchProjects).toHaveBeenCalledTimes(2);
    root.unmount();
  });

  it('reports a failed stats reset with a titled toast', () => {
    const { root } = renderAdmin('/admin/system');
    mocks.resetMutationOptions?.onError?.(new Error('Rate limiter offline'));
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't reset API usage stats.", {
      description: 'Rate limiter offline',
    });
    root.unmount();
  });
});
