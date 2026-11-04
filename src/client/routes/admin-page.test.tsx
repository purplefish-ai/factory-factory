// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import AdminDashboardPage from './admin-page';

const mocks = vi.hoisted(() => ({
  statsError: null as Error | null,
  processesError: null as Error | null,
  projectsError: null as Error | null,
  refetchStats: vi.fn(),
  refetchProcesses: vi.fn(),
  refetchProjects: vi.fn(),
  resetMutationOptions: undefined as { onError?: (error: Error) => void } | undefined,
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));

vi.mock('@/client/features/slack', () => ({
  SlackSettings: () => createElement('section', null, 'Slack'),
}));

vi.mock('@/client/features/codex-accounts', () => ({
  CodexAccountsSettings: () => createElement('section', null, 'Codex accounts'),
}));

vi.mock('@/client/components/app-header-context', () => ({
  HeaderLeftExtraSlot: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  useAppHeader: vi.fn(),
}));

vi.mock('@/client/components/loading', () => ({
  Loading: ({ message }: { message: string }) => createElement('div', null, message),
}));

vi.mock('@/client/features/workspace', () => ({
  WorkspacesBackLink: ({ projectSlug }: { projectSlug: string }) =>
    createElement('a', { href: `/projects/${projectSlug}/workspaces` }, 'Back'),
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
        useQuery: () => ({
          data: mocks.statsError ? undefined : { apiUsage: [], environment: 'test' },
          error: mocks.statsError,
          isLoading: false,
          isFetching: false,
          refetch: mocks.refetchStats,
        }),
      },
      getActiveProcesses: {
        useQuery: () => ({
          data: mocks.processesError ? undefined : [],
          error: mocks.processesError,
          isLoading: false,
          isFetching: false,
          refetch: mocks.refetchProcesses,
        }),
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
  mocks.processesError = null;
  mocks.projectsError = null;
  mocks.resetMutationOptions = undefined;
  vi.clearAllMocks();
});

describe('AdminDashboardPage settings tabs', () => {
  it('separates general and project settings into top tabs', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(AdminDashboardPage));
    });

    expect(container.textContent).toContain('General settings');
    expect(container.textContent).toContain('Project settings');
    expect(container.textContent).not.toContain('Manage scheduled agents and their runs.');
    expect(container.querySelector('a[href="/projects/alpha/agents"]')).toBeNull();
    expect(container.textContent).not.toContain('Periodic Tasks');
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[];
    const generalTab = tabs.find((tab) => tab.textContent?.includes('General settings'));
    const projectTab = tabs.find((tab) => tab.textContent?.includes('Project settings'));

    expect(generalTab).toBeDefined();
    expect(projectTab).not.toBeNull();
    expect(generalTab?.getAttribute('aria-selected')).toBe('true');
    expect(projectTab?.getAttribute('aria-selected')).toBe('false');

    const activePanelBefore = container.querySelector('[role="tabpanel"][data-state="active"]');
    expect(activePanelBefore?.textContent).toContain('Notification Settings');
    expect(activePanelBefore?.textContent).not.toContain('Factory Configuration');

    flushSync(() => {
      projectTab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      projectTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(generalTab?.getAttribute('aria-selected')).toBe('false');
    expect(projectTab?.getAttribute('aria-selected')).toBe('true');

    const activePanelAfter = container.querySelector('[role="tabpanel"][data-state="active"]');
    expect(activePanelAfter?.textContent).toContain('Factory Configuration');
    expect(activePanelAfter?.textContent).not.toContain('Notification Settings');

    root.unmount();
  });

  it('renders workspaces back link for the selected project slug from storage', () => {
    localStorage.setItem(SELECTED_PROJECT_KEY, 'beta');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(AdminDashboardPage));
    });

    const backLink = container.querySelector('a[href="/projects/beta/workspaces"]');
    expect(backLink).not.toBeNull();

    root.unmount();
  });
});

function renderAdmin() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(createElement(AdminDashboardPage));
  });
  return { container, root };
}

function clickButton(container: HTMLElement, label: string, index = 0) {
  const buttons = Array.from(container.querySelectorAll('button')).filter(
    (button) => button.textContent === label
  );
  flushSync(() => buttons[index]?.click());
}

describe('AdminDashboardPage load failures', () => {
  it('shows API usage and process errors with Retry instead of zeroed stats', () => {
    mocks.statsError = new Error('Stats unavailable');
    mocks.processesError = new Error('Process list unavailable');
    const { container, root } = renderAdmin();

    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      expect.stringContaining("Couldn't load API usage"),
      expect.stringContaining("Couldn't load active processes"),
    ]);
    expect(
      [...container.querySelectorAll('section')].some(
        (section) => section.textContent === 'API usage'
      )
    ).toBe(false);
    expect(container.textContent).not.toContain('Processes');
    expect(container.textContent).toContain('Notification Settings');

    clickButton(container, 'Retry', 0);
    expect(mocks.refetchStats).toHaveBeenCalledOnce();
    clickButton(container, 'Retry', 1);
    expect(mocks.refetchProcesses).toHaveBeenCalledOnce();

    root.unmount();
  });

  it('shows a project load error in the project tab instead of loading forever', () => {
    mocks.projectsError = new Error('Projects unavailable');
    const { container, root } = renderAdmin();

    const projectTab = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (tab) => tab.textContent?.includes('Project settings')
    );
    flushSync(() => {
      projectTab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      projectTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const panel = container.querySelector('[role="tabpanel"][data-state="active"]');
    expect(panel?.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load projects");
    expect(panel?.textContent).not.toContain('Loading projects…');

    clickButton(container, 'Retry');
    expect(mocks.refetchProjects).toHaveBeenCalledOnce();

    root.unmount();
  });

  it('reports a failed stats reset with a titled toast', () => {
    const { root } = renderAdmin();

    mocks.resetMutationOptions?.onError?.(new Error('Rate limiter offline'));

    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't reset API usage stats.", {
      description: 'Rate limiter offline',
    });

    root.unmount();
  });
});
