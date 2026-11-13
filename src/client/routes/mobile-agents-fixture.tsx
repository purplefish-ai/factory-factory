import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { useEffect, useRef, useState } from 'react';
import { AppHeader } from '@/client/components/app-header';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import { AppSidebar } from '@/client/components/app-sidebar';
import { ProjectHeader } from '@/client/components/project-header';
import { AgentDetail } from '@/client/features/agents/agent-detail';
import { AgentForm } from '@/client/features/agents/agent-form';
import { AgentRunHistory } from '@/client/features/agents/agent-run-history';
import { AgentsDashboardShell } from '@/client/features/agents/agents-dashboard-shell';
import { EventAgentCreate } from '@/client/features/agents/event-agent-create';
import { eventSummaryFixture } from '@/client/features/agents/event-agent.test-support';
import type { Agent, AgentRun } from '@/client/features/agents/types';
import { hostLoadHistory } from '@/client/features/host-metrics/host-load.story-fixtures';
import {
  AppNavigationDataProvider,
  type AppNavigationData,
} from '@/client/hooks/use-app-navigation-data';
import { getProjectAgentPath } from '@/client/lib/project-navigation';
import type { StoryTrpcHandlers } from '@/client/lib/storybook-trpc';
import { trpc } from '@/client/lib/trpc';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EventAgentWorkspaceForm } from './agents/event-agent-workspace-form';
import { eventWorkspaceHandlers } from './agents/event-agent-workspace-form.story-fixtures';
import { mobileEventFixtures, MobileEventAgentContent } from './mobile-event-agents-fixture';

const fixtureHandlers: StoryTrpcHandlers = {
  ...eventWorkspaceHandlers,
  'github.listIssuesForProject': () => ({ issues: [] }),
  'admin.getHostMetrics': () => ({ samples: hostLoadHistory(24, 43) }),
};

const project = { id: 'factory', slug: 'factory-factory', name: 'Factory Factory' };
const projectDefaults = {
  repoPath: '/fixture/repository',
  worktreeBasePath: '/fixture/worktrees',
  defaultBranch: 'main',
  githubOwner: 'example',
  githubRepo: 'repo',
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
const navigation: AppNavigationData = {
  projects: [
    { ...projectDefaults, ...project },
    { ...projectDefaults, id: 'other', slug: 'other', name: 'Other project' },
  ],
  projectsError: null,
  refetchProjects: () => Promise.reject(new Error('Fixture projects are static.')),
  selectedProjectSlug: project.slug,
  selectProjectSlug: () => undefined,
  selectedProjectId: project.id,
  issueProvider: 'GITHUB',
  serverWorkspaces: [],
  reviewCount: 2,
  agentsSummary: undefined,
  needsAttention: () => false,
  clearAttention: () => undefined,
  currentWorkspaceId: undefined,
};
function previousRuns(periodicTaskId: string): AgentRun[] {
  return [
    {
      id: 'previous-run',
      periodicTaskId,
      launchSnapshot: null,
      workspaceId: 'archived-run',
      status: 'PR_CREATED',
      startedAt: new Date('2026-01-12T14:00:00.000Z'),
      completedAt: new Date('2026-01-12T14:10:00.000Z'),
      prUrl: 'https://github.com/example/repo/pull/42',
      prNumber: 42,
      errorMessage: null,
    },
  ];
}
const review: Agent = {
  id: 'review',
  projectId: project.id,
  name: 'Review recent changes',
  prompt: 'Review recent changes for regressions. Open a focused pull request with verified fixes.',
  cadence: 'DAILY',
  scheduledTime: '09:00',
  timezone: 'America/New_York',
  scheduledDayOfMonth: null,
  isEnabled: true,
  nextRunAt: new Date('2026-01-13T14:00:00.000Z'),
  lastRunAt: new Date('2026-01-12T14:00:00.000Z'),
  createdAt: new Date('2026-01-01T14:00:00.000Z'),
  updatedAt: new Date('2026-01-12T14:00:00.000Z'),
  executions: previousRuns('review'),
};
const dependencies: Agent = {
  ...review,
  id: 'dependencies',
  name: 'Keep dependencies current',
  prompt: 'Check for safe dependency updates and open a focused pull request.',
  cadence: 'WEEKLY',
  isEnabled: false,
  executions: previousRuns('dependencies'),
};

function startFixtureCreation(
  kind: 'scheduled' | 'event',
  selectedKind: 'scheduled' | 'event',
  setSelectedKind: (kind: 'scheduled' | 'event') => void,
  setFormMode: (mode: 'create' | 'create-event') => void
) {
  setSelectedKind(kind === 'scheduled' ? 'scheduled' : selectedKind);
  setFormMode(kind === 'event' ? 'create-event' : 'create');
}

function fixtureEventCreation(mode: string | null, onCancel: () => void) {
  return mode === 'create-event' ? (
    <EventAgentCreate>
      <EventAgentWorkspaceForm
        projectId={project.id}
        projectSlug={project.slug}
        onCancel={onCancel}
      />
    </EventAgentCreate>
  ) : null;
}

/** Frontend-only phone fixture; shared components retain their production links. */
function MobileAgentsSession() {
  const nextAgentId = useRef(1);
  const [agents, setAgents] = useState(() =>
    new URLSearchParams(window.location.search).has('many-agents')
      ? [
          review,
          dependencies,
          ...Array.from({ length: 12 }, (_, index) => ({
            ...review,
            id: `extra-${index}`,
            name: `Additional agent ${index + 1}`,
            executions: [],
          })),
        ]
      : [review, dependencies]
  );
  const [selectedId, setSelectedId] = useState(review.id);
  const [selectedKind, setSelectedKind] = useState<'scheduled' | 'event'>('scheduled');
  const [events, setEvents] = useState(() => mobileEventFixtures(project.id));
  const selectedEvent = events.find((event) => event.id === selectedId);
  const [formMode, setFormMode] = useState<'create' | 'create-event' | 'edit' | null>(null);
  const navData = {
    ...navigation,
    agentsSummary: {
      totalCount: agents.length + events.length,
      failedCount: agents.filter(
        (agent) =>
          agent.executions
            .filter((run) => run.status === 'FAILED' || run.status === 'PR_CREATED')
            .sort(
              (a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.id.localeCompare(a.id)
            )[0]?.status === 'FAILED'
      ).length,
    },
  };
  const selected = agents.find((agent) => agent.id === selectedId) ?? review;
  return (
    <div
      className="h-dvh min-w-0"
      onClickCapture={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        const href = target.closest('a')?.getAttribute('href');
        const agent = agents.find(
          (candidate) => href === `/projects/${project.slug}/agents/${candidate.id}`
        );
        const savedEvent = events.find(
          (candidate) => href === getProjectAgentPath(project.slug, candidate.id, 'event')
        );
        if (savedEvent) {
          event.preventDefault();
          setSelectedId(savedEvent.id);
          setSelectedKind('event');
          setFormMode(null);
        }
        if (agent) {
          // Only selection is local to this fixture. Workspace links use the real router.
          event.preventDefault();
          setSelectedId(agent.id);
          setSelectedKind('scheduled');
          setFormMode(null);
        }
      }}
    >
      <AppNavigationDataProvider value={navData}>
        <SidebarProvider className="h-full min-h-0 w-full flex-col">
          <TooltipProvider>
            <AppHeaderProvider>
              <AppHeader />
              <ProjectHeader project={project} />
              <div className="flex min-h-0 w-full flex-1 overflow-hidden">
                <AppSidebar navData={navData} />
                <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                  <AgentsDashboardShell
                    projectSlug={project.slug}
                    agents={[
                      ...agents,
                      ...events.map((event) => ({
                        ...eventSummaryFixture(event),
                        kind: 'event' as const,
                      })),
                    ]}
                    selectedKind={selectedKind}
                    selectedAgentId={formMode?.startsWith('create') ? undefined : selectedId}
                    onCreate={(kind) =>
                      startFixtureCreation(kind, selectedKind, setSelectedKind, setFormMode)
                    }
                  >
                    {fixtureEventCreation(formMode, () => setFormMode(null)) ??
                      (selectedKind === 'event' && selectedEvent ? (
                        <MobileEventAgentContent
                          agent={selectedEvent}
                          editing={formMode === 'edit'}
                          onEdit={() => setFormMode('edit')}
                          onCancel={() => setFormMode(null)}
                          onSaved={(updated) => {
                            setEvents((current) =>
                              current.map((event) => (event.id === updated.id ? updated : event))
                            );
                            setFormMode(null);
                          }}
                        />
                      ) : formMode ? (
                        <>
                          <h2 className="text-xl font-semibold">
                            {formMode === 'edit' ? 'Edit automation' : 'Create automation'}
                          </h2>
                          <AgentForm
                            key={`${formMode}-${selectedId}`}
                            initialValues={formMode === 'edit' ? selected : undefined}
                            onCancel={() => setFormMode(null)}
                            onSave={(values) => {
                              const now = new Date();
                              const base: Agent =
                                formMode === 'create'
                                  ? {
                                      id: `fixture-agent-${nextAgentId.current++}`,
                                      projectId: project.id,
                                      name: '',
                                      prompt: '',
                                      cadence: 'DAILY',
                                      scheduledTime: null,
                                      timezone: null,
                                      scheduledDayOfMonth: null,
                                      isEnabled: true,
                                      nextRunAt: now,
                                      lastRunAt: null,
                                      createdAt: now,
                                      updatedAt: now,
                                      executions: [],
                                    }
                                  : selected;
                              const updated = { ...base, ...values, updatedAt: now };
                              setAgents((current) =>
                                formMode === 'create'
                                  ? [...current, updated]
                                  : current.map((agent) =>
                                      agent.id === selected.id ? updated : agent
                                    )
                              );
                              setSelectedId(updated.id);
                              setFormMode(null);
                              return Promise.resolve();
                            }}
                          />
                        </>
                      ) : (
                        <AgentDetail
                          agent={selected}
                          onEdit={() => setFormMode('edit')}
                          onToggle={() =>
                            setAgents((current) =>
                              current.map((agent) =>
                                agent.id === selected.id
                                  ? { ...agent, isEnabled: !agent.isEnabled }
                                  : agent
                              )
                            )
                          }
                          onDelete={() => undefined}
                        >
                          <AgentRunHistory projectSlug={project.slug} runs={selected.executions} />
                        </AgentDetail>
                      ))}
                  </AgentsDashboardShell>
                </div>
              </div>
            </AppHeaderProvider>
          </TooltipProvider>
        </SidebarProvider>
      </AppNavigationDataProvider>
    </div>
  );
}

/** Isolate frontend-only sidebar/search fixture queries from the real backend. */
export function MobileAgentsFixture() {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        () =>
          ({ op }) =>
            observable((observer) => {
              const handler = Object.entries(fixtureHandlers).find(
                ([path]) => path === op.path
              )?.[1];
              observer.next({ result: { data: handler ? handler(op.input) : [] } });
              observer.complete();
            }),
      ],
    })
  );
  useEffect(() => () => queryClient.clear(), [queryClient]);
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <MobileAgentsSession />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
