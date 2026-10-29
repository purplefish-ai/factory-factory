import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { type ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AppHeader } from '@/client/components/app-header';
import { AppHeaderProvider, useAppHeader } from '@/client/components/app-header-context';
import { ProjectHeader } from '@/client/components/project-header';
import { WorkspacePanelProvider } from '@/client/features/workspace';
import {
  AppNavigationDataProvider,
  type AppNavigationData,
} from '@/client/hooks/use-app-navigation-data';
import { trpc } from '@/client/lib/trpc';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceDetailHeaderSlot } from './projects/workspaces/workspace-detail-header.js';
import type { WorkspaceHeaderWorkspace } from './projects/workspaces/workspace-detail-header/types';

const project = {
  id: 'header-project',
  slug: 'header-project',
  name: 'Factory Factory with an exceptionally long project name',
};
const workspace: Partial<WorkspaceHeaderWorkspace> & { id: string } = {
  id: 'header-workspace',
  projectId: project.id,
  name: 'A deliberately long workspace title for responsive header regression coverage',
  branchName: 'purplefish-ai/our-projects-page-long-workspace-branch',
  status: 'READY',
  worktreePath: '/fixture/worktree',
  description: 'Frontend-only header fixture.',
  creationMetadata: null,
  defaultSessionProvider: 'WORKSPACE_DEFAULT',
  ratchetEnabled: true,
  ratchetState: 'IDLE',
  prs: [
    {
      id: 'header-pr',
      url: 'https://github.com/example/repo/pull/2643',
      number: 2643,
      title: 'Compact workspace header',
      headRefName: 'fixture-previous-branch',
      baseRefName: 'main',
      state: 'MERGED',
      reviewState: null,
      ciStatus: 'SUCCESS',
      hasMergeConflict: false,
      syncedAt: null,
    },
  ],
  prState: 'MERGED',
  prSummary: {
    totalCount: 1,
    openCount: 0,
    hasNonterminal: false,
    state: 'MERGED',
    ciStatus: 'SUCCESS',
    hasMergeConflict: false,
    ratchetState: 'MERGED',
  },
  sidebarStatus: { activityState: 'IDLE', ciState: 'MERGED' },
  prMonitoring: {
    deliveryMode: 'MAIN',
    enabled: true,
    recipientSessionId: null,
    bindingRevision: 1,
    pauseReason: null,
    pendingEventCount: 0,
  },
  githubIssueNumber: 3456,
  githubIssueUrl: 'https://github.com/example/repo/issues/3456',
};
const navigation: AppNavigationData = {
  projects: undefined,
  projectsError: null,
  refetchProjects: () => Promise.reject(new Error('Static fixture')),
  selectedProjectSlug: project.slug,
  selectProjectSlug: () => undefined,
  selectedProjectId: project.id,
  issueProvider: 'GITHUB',
  serverWorkspaces: [],
  reviewCount: 0,
  agentsSummary: undefined,
  needsAttention: () => false,
  clearAttention: () => undefined,
  currentWorkspaceId: workspace.id,
};
function FixtureNavigation({
  projectsError,
  children,
}: {
  projectsError: boolean;
  children: ReactNode;
}) {
  const [retryCount, setRetryCount] = useState(0);
  const projects = trpc.project.list.useQuery({ isArchived: false }, { enabled: false });
  return (
    <AppNavigationDataProvider
      value={{
        ...navigation,
        projectsError:
          projectsError && retryCount === 0
            ? TRPCClientError.from(new Error('Project refresh unavailable'))
            : null,
        refetchProjects: () => {
          setRetryCount((count) => count + 1);
          return projects.refetch();
        },
      }}
    >
      {children}
      <output aria-label="Project retry count" className="sr-only">
        {retryCount}
      </output>
    </AppNavigationDataProvider>
  );
}
function GenericHeader() {
  useAppHeader({ title: 'Application settings with an exceptionally long page title' });
  return null;
}
function FixtureHeader({ variant }: { variant: string | null }) {
  if (variant === 'generic') {
    return <GenericHeader />;
  }
  if (variant === 'project') {
    return <ProjectHeader project={project} />;
  }
  return (
    <WorkspaceDetailHeaderSlot
      workspace={workspace as WorkspaceHeaderWorkspace}
      workspaceId={workspace.id}
      availableIdes={[{ id: 'vscode', name: 'VS Code' }]}
      preferredIde="vscode"
      openInIde={{ mutate: () => undefined, isPending: false }}
      archivePending={false}
      onArchiveRequest={() => undefined}
      handleQuickAction={async () => undefined}
      running={false}
      isCreatingSession={false}
      hasChanges
    />
  );
}

/** Actual portal/header composition with isolated static reads and no backend writes. */
export function WorkspaceHeaderFixture({
  variant: storyVariant,
  projectsError = false,
}: { variant?: string; projectsError?: boolean } = {}) {
  const [params] = useSearchParams();
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              if (op.type !== 'query') {
                observer.error(
                  TRPCClientError.from(
                    new Error('Header fixture does not execute workspace actions.')
                  )
                );
                return;
              }
              const data = (() => {
                switch (op.path) {
                  case 'project.getBySlug':
                    return project;
                  case 'project.getById':
                    return { ...project, githubOwner: 'example', githubRepo: 'repo' };
                  case 'workspace.getRunScriptStatus':
                    return {
                      hasRunScript: true,
                      status: 'RUNNING',
                      port: 5184,
                      runScriptCommand: 'pnpm dev',
                    };
                  case 'workspace.listForProject':
                    return [];
                  case 'userSettings.get':
                    return { defaultSessionProvider: 'CLAUDE' };
                  case 'admin.checkCLIHealth':
                    return {
                      claude: { isInstalled: true },
                      codex: { isInstalled: true, isAuthenticated: true },
                    };
                  case 'search.githubIssues':
                    return { results: [], errors: [] };
                  default:
                    return [];
                }
              })();
              observer.next({ result: { data } });
              observer.complete();
            }),
      ],
    })
  );
  useEffect(() => () => queryClient.clear(), [queryClient]);
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <FixtureNavigation projectsError={projectsError || params.get('projectsError') === '1'}>
          <SidebarProvider className="h-dvh min-h-0 w-full flex-col">
            <TooltipProvider>
              <AppHeaderProvider>
                <AppHeader />
                <WorkspacePanelProvider workspaceId={workspace.id}>
                  <FixtureHeader variant={storyVariant ?? params.get('header')} />
                </WorkspacePanelProvider>
                <main className="p-4 text-sm text-muted-foreground">Responsive header fixture</main>
              </AppHeaderProvider>
            </TooltipProvider>
          </SidebarProvider>
        </FixtureNavigation>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
