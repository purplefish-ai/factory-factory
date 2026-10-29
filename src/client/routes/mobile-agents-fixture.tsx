import { useState } from 'react';
import { AppHeader } from '@/client/components/app-header';
import { AppHeaderProvider } from '@/client/components/app-header-context';
import { ProjectSectionHeader } from '@/client/components/project-section-header';
import { AgentDetail } from '@/client/features/agents/agent-detail';
import { AgentForm } from '@/client/features/agents/agent-form';
import { AgentRunHistory } from '@/client/features/agents/agent-run-history';
import { AgentsDashboardShell } from '@/client/features/agents/agents-dashboard-shell';
import type { Agent, AgentRun } from '@/client/features/agents/types';
import {
  AppNavigationDataProvider,
  type AppNavigationData,
} from '@/client/hooks/use-app-navigation-data';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

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
  needsAttention: () => false,
  clearAttention: () => undefined,
  currentWorkspaceId: undefined,
};
function previousRuns(periodicTaskId: string): AgentRun[] {
  return [
    {
      id: 'previous-run',
      periodicTaskId,
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

/** Frontend-only phone fixture; shared components retain their production links. */
export function MobileAgentsFixture() {
  const [agents, setAgents] = useState([review, dependencies]);
  const [selectedId, setSelectedId] = useState(review.id);
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
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
        if (agent) {
          // Only selection is local to this fixture. Workspace links use the real router.
          event.preventDefault();
          setSelectedId(agent.id);
          setFormMode(null);
        }
      }}
    >
      <AppNavigationDataProvider value={navigation}>
        <SidebarProvider className="h-full min-h-0 w-full flex-col">
          <TooltipProvider>
            <AppHeaderProvider>
              <AppHeader />
              <ProjectSectionHeader project={project} />
              <div className="min-h-0 w-full flex-1 overflow-hidden">
                <AgentsDashboardShell
                  projectSlug={project.slug}
                  agents={agents}
                  selectedAgentId={formMode === 'create' ? undefined : selected.id}
                  onCreate={() => setFormMode('create')}
                >
                  {formMode ? (
                    <>
                      <h2 className="text-xl font-semibold">
                        {formMode === 'edit' ? 'Edit Agent' : 'Create Agent'}
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
                                  id: crypto.randomUUID(),
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
                              : current.map((agent) => (agent.id === selected.id ? updated : agent))
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
                      projectName={project.name}
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
                  )}
                </AgentsDashboardShell>
              </div>
            </AppHeaderProvider>
          </TooltipProvider>
        </SidebarProvider>
      </AppNavigationDataProvider>
    </div>
  );
}
