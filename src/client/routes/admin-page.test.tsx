// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminDashboardPage from './admin-page';

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/client/components/app-header-context', () => ({
  HeaderLeftExtraSlot: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
  useAppHeader: vi.fn(),
}));

vi.mock('@/client/components/loading', () => ({
  Loading: ({ message }: { message: string }) => createElement('div', null, message),
}));

vi.mock('@/client/components/provider-cli-warning', () => ({
  ProviderCliWarning: () => createElement('div', null, 'Provider CLI warning'),
}));

vi.mock('@/client/hooks/use-download-server-log', () => ({
  useDownloadServerLog: () => ({ download: vi.fn(), isDownloading: false }),
}));

vi.mock('@/client/lib/download-file', () => ({
  downloadFile: vi.fn(),
}));

vi.mock('@/components/data-import/data-import-button', () => ({
  DataImportButton: () => createElement('button', null, 'Import Data'),
}));

vi.mock('@/components/factory-config-scripts', () => ({
  FactoryConfigScripts: () => createElement('div', null, 'Factory config scripts'),
}));

vi.mock('@/components/workspace', () => ({
  RatchetWrenchIcon: () => createElement('span', null, 'ratchet'),
  WorkspacesBackLink: () => createElement('a', { href: '/projects' }, 'Back'),
}));

vi.mock('@/components/workspace/dev-server-setup-panel', () => ({
  DevServerSetupPanel: () => null,
}));

vi.mock('./admin/index', () => ({
  ApiUsageSection: () => createElement('section', null, 'API Usage'),
  ProcessesSection: () => createElement('section', null, 'Processes'),
  ProcessesSectionSkeleton: () => createElement('section', null, 'Processes Loading'),
  ProjectIssueTrackingCard: () => createElement('section', null, 'Issue Tracking Card'),
}));

vi.mock('@/client/lib/trpc', () => {
  const mutation = { mutate: vi.fn(), isPending: false, error: null };
  const userSettings = {
    playSoundOnComplete: true,
    preferredIde: 'cursor',
    customIdeCommand: null,
    defaultSessionProvider: 'CLAUDE',
    defaultWorkspacePermissions: 'STRICT',
    ratchetEnabled: false,
    ratchetPermissions: 'YOLO',
  };
  const projects = [
    {
      id: 'project-1',
      slug: 'alpha',
      name: 'Alpha',
      issueProvider: 'github',
      issueTrackerConfig: null,
    },
  ];

  return {
    trpc: {
      useUtils: () => ({
        userSettings: { get: { invalidate: vi.fn() } },
        workspace: {
          getAvailableIdes: { invalidate: vi.fn() },
          getFactoryConfig: { invalidate: vi.fn() },
        },
        admin: {
          exportData: { fetch: vi.fn(async () => ({})) },
        },
      }),
      userSettings: {
        get: { useQuery: () => ({ data: userSettings, isLoading: false }) },
        update: { useMutation: () => mutation },
        testCustomCommand: { useMutation: () => mutation },
      },
      admin: {
        getServerInfo: { useQuery: () => ({ data: { backendPort: 3001 }, isLoading: false }) },
        triggerRatchetCheck: { useMutation: () => mutation },
        getSystemStats: {
          useQuery: () => ({
            data: { apiUsage: [], environment: 'test' },
            isLoading: false,
            refetch: vi.fn(),
          }),
        },
        getActiveProcesses: {
          useQuery: () => ({
            data: [],
            isLoading: false,
          }),
        },
        resetApiUsageStats: { useMutation: () => mutation },
      },
      project: {
        list: { useQuery: () => ({ data: projects }) },
        saveFactoryConfig: { useMutation: () => mutation },
      },
      workspace: {
        getFactoryConfig: { useQuery: () => ({ data: null }) },
        refreshFactoryConfigs: { useMutation: () => mutation },
      },
    },
  };
});

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
});
