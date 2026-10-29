import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AgentDetail } from './agent-detail';
import { AgentForm } from './agent-form';
import { AgentRunHistoryQuery } from './agent-run-history';
import { AgentsDashboardShell } from './agents-dashboard-shell';
import type { AgentProject } from './types';
import { useAgentsController } from './use-agents-controller';

type Controller = ReturnType<typeof useAgentsController>;
function RequestError({
  children,
  retry,
  label,
}: {
  children: ReactNode;
  retry: () => void;
  label: string;
}) {
  return (
    <div role="alert" className="space-y-3">
      <p className="text-sm text-destructive">{children}</p>
      <Button variant="outline" size="sm" onClick={retry}>
        {label}
      </Button>
    </div>
  );
}
function Loading({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {children}
    </p>
  );
}
function AgentRequestError({
  task,
  refresh = false,
}: {
  task: Controller['task'];
  refresh?: boolean;
}) {
  if (!task.error) {
    return null;
  }
  return (
    <RequestError
      label="Retry agent"
      retry={() => {
        void task.refetch();
      }}
    >
      {task.error.data?.code === 'NOT_FOUND'
        ? 'Agent not found. This agent is no longer available.'
        : `Could not ${refresh ? 'refresh' : 'load'} agent: ${task.error.message}`}
    </RequestError>
  );
}
function AgentSelectionContent({ controller }: { controller: Controller }) {
  const { id, task, project, mode } = controller;
  if (controller.wrongOwner) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Agent not found in this project.
      </p>
    );
  }
  if (mode === 'create' && project) {
    return (
      <>
        <div>
          <h2 className="text-xl font-semibold">Create Agent</h2>
        </div>
        <AgentForm
          key={`create-${project.id}`}
          onSave={controller.save}
          onCancel={() => controller.setMode('detail')}
        />
      </>
    );
  }
  // Keep mounted editors and their drafts during background query failures.
  if (mode === 'edit' && task.data) {
    return (
      <>
        <h2 className="text-xl font-semibold">Edit Agent</h2>
        <AgentRequestError task={task} refresh />
        <AgentForm
          key={`edit-${task.data.id}`}
          initialValues={task.data}
          onSave={controller.save}
          onCancel={() => controller.setMode('detail')}
        />
      </>
    );
  }
  if (id && task.error && (!task.data || task.error.data?.code === 'NOT_FOUND')) {
    return <AgentRequestError task={task} />;
  }
  if (id && task.isLoading) {
    return <Loading>Loading agent…</Loading>;
  }
  if (task.data && project) {
    return (
      <>
        <AgentRequestError task={task} refresh />
        <AgentDetail
          agent={task.data}
          onEdit={() => controller.setMode('edit')}
          onToggle={controller.toggle}
          onDelete={controller.openDelete}
          pending={controller.pending}
          error={controller.actionError}
        >
          <AgentRunHistoryQuery periodicTaskId={task.data.id} projectSlug={project.slug} />
        </AgentDetail>
      </>
    );
  }
  return (
    <div className="py-12 text-center">
      <h2 className="text-lg font-semibold">Give recurring work an agent</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Create an agent with instructions and a schedule.
      </p>
    </div>
  );
}
function AgentsPageSession({ project: routeProject }: { project: AgentProject }) {
  const controller = useAgentsController(routeProject);
  const { id, task, list, project, mode, pending, actionError } = controller;
  return (
    <>
      <AgentsDashboardShell
        projectSlug={project.slug}
        agents={list.data}
        selectedAgentId={mode === 'create' ? undefined : id}
        isLoading={list.isLoading || (!!id && task.isLoading)}
        error={list.error ? `Could not load agents: ${list.error.message}` : undefined}
        onRetry={() => {
          void list.refetch();
        }}
        onCreate={controller.startCreate}
        createDisabled={controller.createDisabled}
        onAgentSelect={controller.selectAgent}
      >
        <AgentSelectionContent controller={controller} />
      </AgentsDashboardShell>
      <ConfirmDialog
        open={controller.deleteOpen}
        onOpenChange={(open) => {
          if (!pending) {
            controller.setDeleteOpen(open);
          }
        }}
        title="Delete Agent?"
        description={`The agent definition and run history will be removed. Generated workspaces and conversations are preserved.${actionError ? ` ${actionError}` : ''}`}
        confirmText="Delete Agent"
        variant="destructive"
        onConfirm={controller.deleteAgent}
        isPending={pending}
      />
    </>
  );
}

/** Navigation creates a fresh editing session; polling keeps the existing draft. */
export function AgentsPage({ project }: { project: AgentProject }) {
  const location = useLocation();
  return <AgentsPageSession key={`${project.id}:${location.key}`} project={project} />;
}
