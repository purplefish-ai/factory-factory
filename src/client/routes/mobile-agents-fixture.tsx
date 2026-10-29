import { useState } from 'react';
import {
  type Agent,
  AgentDetail,
  AgentForm,
  AgentRunHistory,
  AgentsDashboardShell,
} from '@/client/features/agents';

const project = { id: 'factory', slug: 'factory-factory', name: 'Factory Factory' };
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
  executions: [],
};
const dependencies: Agent = {
  ...review,
  id: 'dependencies',
  name: 'Keep dependencies current',
  prompt: 'Check for safe dependency updates and open a focused pull request.',
  cadence: 'WEEKLY',
  isEnabled: false,
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
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        const href = target.closest('a')?.getAttribute('href');
        const agent = agents.find((candidate) => href === `/agents/${candidate.id}`);
        if (agent) {
          // Only selection is local to this fixture. Workspace links use the real router.
          event.preventDefault();
          setSelectedId(agent.id);
          setFormMode(null);
        }
      }}
    >
      <AgentsDashboardShell
        projects={[project]}
        projectId={project.id}
        agents={agents}
        selectedAgentId={formMode === 'create' ? undefined : selected.id}
        onProjectChange={() => undefined}
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
                const updated = {
                  ...selected,
                  ...values,
                  id: formMode === 'create' ? 'created' : selected.id,
                };
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
                  agent.id === selected.id ? { ...agent, isEnabled: !agent.isEnabled } : agent
                )
              )
            }
            onDelete={() => undefined}
          >
            <AgentRunHistory
              projectSlug={project.slug}
              runs={[
                {
                  id: 'previous-run',
                  periodicTaskId: selected.id,
                  workspaceId: 'archived-run',
                  status: 'PR_CREATED',
                  startedAt: new Date('2026-01-12T14:00:00.000Z'),
                  completedAt: new Date('2026-01-12T14:10:00.000Z'),
                  prUrl: 'https://github.com/example/repo/pull/42',
                  prNumber: 42,
                  errorMessage: null,
                },
              ]}
            />
          </AgentDetail>
        )}
      </AgentsDashboardShell>
    </div>
  );
}
