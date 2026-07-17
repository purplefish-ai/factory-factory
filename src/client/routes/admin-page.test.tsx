// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import AdminDashboardPage from './admin-page';

const mocks = vi.hoisted(() => ({
  updateSettingsMutate: vi.fn(),
  testCustomCommandMutate: vi.fn(),
  userSettings: {
    playSoundOnComplete: true,
    preferredIde: 'cursor' as 'cursor' | 'vscode' | 'custom',
    customIdeCommand: null as string | null,
    defaultSessionProvider: 'CLAUDE',
    defaultClaudeModel: 'sonnet',
    defaultCodexModel: 'default',
    defaultClaudeReasoningEffort: null,
    defaultCodexReasoningEffort: null,
    defaultWorkspacePermissions: 'STRICT',
    ratchetEnabled: false,
    ratchetReplyToPrComments: true,
    ratchetReviewTriggerMode: 'CHANGES_REQUESTED' as 'CHANGES_REQUESTED' | 'ALL_REVIEW_FEEDBACK',
    ratchetPermissions: 'YOLO',
  },
}));

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
  WorkspacesBackLink: ({ projectSlug }: { projectSlug: string }) =>
    createElement('a', { href: `/projects/${projectSlug}/workspaces` }, 'Back'),
}));

vi.mock('@/components/workspace/dev-server-setup-panel', () => ({
  DevServerSetupPanel: () => null,
}));

vi.mock('@/components/project/onboarding-cli-health', () => ({
  OnboardingCliHealth: () => createElement('div', null, 'CLI Health'),
}));

vi.mock('@/components/project/setup-terminal-modal', () => ({
  SetupTerminalModal: () => null,
}));

vi.mock('./admin/index', () => ({
  ApiUsageSection: () => createElement('section', null, 'API Usage'),
  PeriodicTasksSection: () => createElement('section', null, 'Periodic Tasks'),
  ProcessesSection: () => createElement('section', null, 'Processes'),
  ProcessesSectionSkeleton: () => createElement('section', null, 'Processes Loading'),
  ProjectIssueTrackingCard: () => createElement('section', null, 'Issue Tracking Card'),
}));

vi.mock('@/client/lib/trpc', () => {
  const mutation = { mutate: vi.fn(), isPending: false, error: null };
  const projects = [
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
        get: { useQuery: () => ({ data: mocks.userSettings, isLoading: false }) },
        getProviderOptions: {
          useQuery: () => ({
            data: {
              CLAUDE: {
                source: 'fallback',
                models: [{ value: 'sonnet', label: 'Sonnet' }],
                efforts: [{ value: 'medium', label: 'Medium' }],
              },
              CODEX: {
                source: 'fallback',
                models: [{ value: 'default', label: 'Default' }],
                efforts: [{ value: 'medium', label: 'Medium' }],
              },
            },
          }),
        },
        update: {
          useMutation: () => ({
            mutate: mocks.updateSettingsMutate,
            isPending: false,
            error: null,
          }),
        },
        testCustomCommand: {
          useMutation: () => ({
            mutate: mocks.testCustomCommandMutate,
            isPending: false,
            error: null,
          }),
        },
      },
      admin: {
        getServerInfo: { useQuery: () => ({ data: { backendPort: 3001 }, isLoading: false }) },
        checkCLIHealth: { useQuery: () => ({ data: null, refetch: vi.fn() }) },
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
  mocks.updateSettingsMutate.mockReset();
  mocks.testCustomCommandMutate.mockReset();
  mocks.userSettings.preferredIde = 'cursor';
  mocks.userSettings.customIdeCommand = null;
  mocks.userSettings.ratchetReviewTriggerMode = 'CHANGES_REQUESTED';
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
  it('updates the Ratchet review feedback trigger mode', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(AdminDashboardPage));
    });

    expect(container.textContent).toContain('Review feedback trigger');
    const trigger = container.querySelector<HTMLElement>('#ratchet-review-trigger');
    expect(trigger?.textContent).toContain('Changes requested and unresolved threads');

    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Radix portals SelectContent into document.body, outside the render container.
    const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]');
    const broadOption = Array.from(
      listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
    ).find((option) => option.textContent?.includes('All review feedback'));
    expect(broadOption).toBeDefined();

    flushSync(() => {
      broadOption?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      broadOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.updateSettingsMutate).toHaveBeenCalledWith({
      ratchetReviewTriggerMode: 'ALL_REVIEW_FEEDBACK',
    });

    root.unmount();
  });

  it('tests the current custom command before it has been saved', () => {
    mocks.userSettings.preferredIde = 'custom';
    mocks.userSettings.customIdeCommand = null;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    flushSync(() => {
      root.render(createElement(AdminDashboardPage));
    });

    const input = container.querySelector<HTMLInputElement>('#custom-command');
    const testButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Test'
    );
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    expect(input).not.toBeNull();
    expect(testButton).toBeDefined();
    expect(testButton?.disabled).toBe(true);

    flushSync(() => {
      setInputValue?.call(input, 'code-insiders {workspace}');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(testButton?.disabled).toBe(false);

    flushSync(() => {
      testButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.testCustomCommandMutate).toHaveBeenCalledWith({
      customCommand: 'code-insiders {workspace}',
    });

    root.unmount();
  });

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
