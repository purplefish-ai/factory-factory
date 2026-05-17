// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AppNavigationData,
  AppNavigationDataProvider,
} from '@/client/hooks/use-app-navigation-data';
import { SELECTED_PROJECT_KEY } from '@/client/lib/project-selection';
import NewProjectPage from './new';

const navigateMock = vi.fn();
const useAppHeaderMock = vi.fn();
const selectProjectSlugMock = vi.fn();
const projects = [
  { id: 'project-1', slug: 'alpha', name: 'Alpha' },
  { id: 'project-2', slug: 'beta', name: 'Beta' },
];

vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
  useLocation: () => ({ pathname: '/projects/new' }),
  useNavigate: () => navigateMock,
}));

vi.mock('@/client/components/app-header-context', () => ({
  HeaderLeftStartSlot: ({ children }: { children: ReactNode }) =>
    createElement('div', { 'data-testid': 'header-left-start' }, children),
  useAppHeader: (input: unknown) => useAppHeaderMock(input),
}));

vi.mock('@/client/components/logo', () => ({
  Logo: () => createElement('div', null, 'Logo'),
}));

vi.mock('@/client/components/project-selector', () => ({
  ProjectSelectorDropdown: ({
    selectedProjectSlug,
    onCurrentProjectSelect,
    projects,
  }: {
    selectedProjectSlug: string;
    onCurrentProjectSelect?: () => void;
    projects: Array<{ slug: string; name: string }> | undefined;
  }) => {
    const selectedProject = projects?.find((project) => project.slug === selectedProjectSlug);
    return createElement(
      'button',
      { onClick: onCurrentProjectSelect, type: 'button' },
      selectedProject?.name ?? 'Select a project'
    );
  },
}));

vi.mock('@/components/data-import/data-import-button', () => ({
  DataImportButton: ({ children }: { children: ReactNode }) =>
    createElement('button', null, children),
}));

vi.mock('@/components/project/github-url-form', () => ({
  GithubUrlForm: ({ footerActions }: { footerActions?: ReactNode }) =>
    createElement('div', null, 'GitHub URL Form', footerActions),
}));

vi.mock('@/components/project/onboarding-cli-health', () => ({
  OnboardingCliHealth: () => createElement('div', null, 'CLI Health'),
}));

vi.mock('@/components/project/project-repo-form', () => ({
  ProjectRepoForm: ({ footerActions }: { footerActions?: ReactNode }) =>
    createElement('div', null, 'Project Repo Form', footerActions),
}));

vi.mock('@/components/project/setup-terminal-modal', () => ({
  SetupTerminalModal: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  CardContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  CardDescription: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  CardHeader: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  CardTitle: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TabsContent: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TabsList: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  TabsTrigger: ({ children }: { children: ReactNode }) =>
    createElement('button', { type: 'button' }, children),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      project: { list: { invalidate: vi.fn() } },
      admin: { checkCLIHealth: { invalidate: vi.fn() } },
    }),
    project: {
      list: { useQuery: () => ({ data: projects }) },
      checkFactoryConfig: { useQuery: () => ({ data: { exists: false } }) },
      checkGithubAuth: { useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }) },
      create: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      createFromGithub: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
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

function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const navigationData = {
    projects,
    selectedProjectSlug: 'beta',
    selectProjectSlug: selectProjectSlugMock,
    selectedProjectId: 'project-2',
    issueProvider: 'GITHUB',
    serverWorkspaces: undefined,
    reviewCount: 0,
    needsAttention: () => false,
    clearAttention: vi.fn(),
    currentWorkspaceId: undefined,
  } as unknown as AppNavigationData;

  flushSync(() => {
    root.render(
      createElement(
        AppNavigationDataProvider,
        { value: navigationData },
        createElement(NewProjectPage)
      )
    );
  });

  return { container, root };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: createStorageStub(),
  });
  localStorage.setItem(SELECTED_PROJECT_KEY, 'beta');
  navigateMock.mockClear();
  useAppHeaderMock.mockClear();
  selectProjectSlugMock.mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('NewProjectPage navigation', () => {
  it('keeps the selected project in the header and navigates to its board', () => {
    const { container, root } = renderPage();

    expect(useAppHeaderMock).toHaveBeenCalledWith({ title: '' });
    const headerProject = container.querySelector('[data-testid="header-left-start"] button');
    expect(headerProject?.textContent).toBe('Beta');

    flushSync(() => {
      headerProject?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith('/projects/beta/workspaces');
    root.unmount();
  });

  it('does not render a generic projects back link on the add project page', () => {
    const { container, root } = renderPage();

    expect(container.querySelector('a[href="/projects"]')).toBeNull();
    expect(container.querySelector('a[href="/projects/beta/workspaces"]')?.textContent).toContain(
      'Cancel'
    );

    root.unmount();
  });
});
