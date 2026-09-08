// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import AdminDashboardPage from './admin-page';

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
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
  ApiUsageSection: () => createElement('section', null, 'API Usage'),
  PeriodicTasksSection: () => createElement('section', null, 'Periodic Tasks'),
  ProcessesSection: () => createElement('section', null, 'Processes'),
  ProcessesSectionSkeleton: () => createElement('section', null, 'Processes Loading'),
  VoiceModeSection: () => createElement('section', null, 'Voice Mode'),
  NotificationSettingsSection: () => createElement('section', null, 'Notification Settings'),
  ProjectSettingsSection: () => createElement('section', null, 'Factory Configuration'),
  AppInfoSection: () => createElement('section', null, 'App Info'),
  ChatProviderDefaultsSection: () => createElement('section', null, 'Chat Defaults'),
  CliAuthSection: () => createElement('section', null, 'CLI Authentication'),
  DataBackupSection: () => createElement('section', null, 'Data Backup'),
  IdeSettingsSection: () => createElement('section', null, 'IDE Settings'),
  RatchetSettingsSection: () => createElement('section', null, 'Ratchet Pull Requests'),
  ServerLogsSection: () => createElement('section', null, 'Server Logs'),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    admin: {
      getSystemStats: {
        useQuery: () => ({
          data: { apiUsage: [], environment: 'test' },
          isLoading: false,
          refetch: vi.fn(),
        }),
      },
      getActiveProcesses: { useQuery: () => ({ data: [], isLoading: false }) },
      resetApiUsageStats: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    project: {
      list: {
        useQuery: () => ({
          data: [
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
});

describe('AdminDashboardPage settings tabs', () => {
  it('separates general and project settings into top tabs', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(AdminDashboardPage));
    });

    expect(container.textContent).toContain('General Settings');
    expect(container.textContent).toContain('Project Settings');
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[];
    const generalTab = tabs.find((tab) => tab.textContent?.includes('General Settings'));
    const projectTab = tabs.find((tab) => tab.textContent?.includes('Project Settings'));

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
