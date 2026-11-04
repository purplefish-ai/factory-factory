import type { ReactNode } from 'react';
import { fn } from 'storybook/test';
import { AppHeaderProvider, useAppHeaderContext } from '@/client/components/app-header-context';
import { AppNavigationDataProvider } from '@/client/hooks/use-app-navigation-data';

function SettingsHeader() {
  const { setLeftStartSlot } = useAppHeaderContext();
  return <header className="flex min-h-12 items-center border-b px-2" ref={setLeftStartSlot} />;
}

const projectDefaults = {
  repoPath: '/repos/example',
  worktreeBasePath: '/worktrees/example',
  defaultBranch: 'main',
  githubOwner: null,
  githubRepo: null,
  isArchived: false,
  issueProvider: 'GITHUB' as const,
  issueTrackerConfig: null,
  startupScriptCommand: null,
  startupScriptPath: null,
  startupScriptTimeout: 300,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  _count: { workspaces: 0 },
};

export function SettingsStoryLayout({
  children,
  selectedProjectSlug = 'factory-factory',
}: {
  children: ReactNode;
  selectedProjectSlug?: string;
}) {
  return (
    <AppNavigationDataProvider
      value={{
        projects: [
          { ...projectDefaults, id: 'factory', slug: 'factory-factory', name: 'Factory Factory' },
          { ...projectDefaults, id: 'other', slug: 'other', name: 'Other project' },
        ],
        projectsError: null,
        refetchProjects: fn(),
        selectedProjectSlug,
        selectProjectSlug: fn(),
        selectedProjectId: 'factory',
        issueProvider: 'GITHUB',
        serverWorkspaces: [],
        reviewCount: 0,
        agentsSummary: undefined,
        needsAttention: () => false,
        clearAttention: fn(),
        currentWorkspaceId: undefined,
      }}
    >
      <AppHeaderProvider>
        <SettingsHeader />
        {children}
      </AppHeaderProvider>
    </AppNavigationDataProvider>
  );
}
