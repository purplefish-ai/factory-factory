import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AgentDetail } from './agent-detail';
import { AgentForm } from './agent-form';
import { AgentRunHistoryQuery } from './agent-run-history';
import { AgentsDashboardShell } from './agents-dashboard-shell';
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
function AgentSelectionContent({ controller }: { controller: Controller }) {
  const { id, task, project, mode } = controller;
  if (mode === 'create' && project) {
    return (
      <>
        <div>
          <p className="mb-2 text-xs text-muted-foreground">{project.name}</p>
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
        {task.error && (
          <RequestError
            label="Retry agent"
            retry={() => {
              void task.refetch();
            }}
          >
            Could not refresh agent: {task.error.message}
          </RequestError>
        )}
        <AgentForm
          key={`edit-${task.data.id}`}
          initialValues={task.data}
          onSave={controller.save}
          onCancel={() => controller.setMode('detail')}
        />
      </>
    );
  }
  if (id && task.error) {
    return (
      <RequestError
        label="Retry agent"
        retry={() => {
          void task.refetch();
        }}
      >
        {task.error.data?.code === 'NOT_FOUND'
          ? 'Agent not found. This agent is no longer available.'
          : `Could not load agent: ${task.error.message}`}
      </RequestError>
    );
  }
  if (id && task.isLoading) {
    return <Loading>Loading agent…</Loading>;
  }
  if (task.data && project) {
    return (
      <AgentDetail
        agent={task.data}
        projectName={project.name}
        onEdit={() => controller.setMode('edit')}
        onToggle={controller.toggle}
        onDelete={() => controller.setDeleteOpen(true)}
        pending={controller.pending}
        error={controller.actionError}
      >
        <AgentRunHistoryQuery periodicTaskId={task.data.id} projectSlug={project.slug} />
      </AgentDetail>
    );
  }
  return (
    <div className="py-12 text-center">
      <h2 className="text-lg font-semibold">
        {project ? 'Give recurring work an agent' : 'Choose a project to get started'}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {project
          ? 'Create an agent with instructions and a schedule.'
          : 'Create a project before adding an agent.'}
      </p>
    </div>
  );
}
function AgentProjectContent({ controller }: { controller: Controller }) {
  if (controller.projectsLoading) {
    return <Loading>Loading projects…</Loading>;
  }
  if (controller.ownerLoading) {
    return <Loading>Loading agent project…</Loading>;
  }
  const hasProjectError = controller.projectsError || controller.ownerError;
  return (
    <>
      {controller.projectsError && (
        <RequestError
          label="Retry projects"
          retry={() => {
            void controller.retryProjects();
          }}
        >
          Could not load projects: {controller.projectsError.message}
        </RequestError>
      )}
      {controller.ownerError && (
        <RequestError
          label="Retry project"
          retry={() => {
            void controller.retryOwner();
          }}
        >
          Could not load agent project: {controller.ownerError.message}
        </RequestError>
      )}
      {(controller.project || !hasProjectError) && (
        <AgentSelectionContent controller={controller} />
      )}
    </>
  );
}
export function AgentsPage() {
  const controller = useAgentsController();
  const { id, list, project, mode, pending, actionError } = controller;
  return (
    <>
      <AgentsDashboardShell
        projects={controller.projects}
        projectId={project?.id}
        agents={list.data}
        selectedAgentId={mode === 'create' ? undefined : id}
        isLoading={list.isLoading || controller.projectsLoading || controller.ownerLoading}
        error={list.error ? `Could not load agents: ${list.error.message}` : undefined}
        onRetry={() => {
          void list.refetch();
        }}
        onProjectChange={controller.selectProject}
        onCreate={controller.startCreate}
        createDisabled={pending || controller.projectsLoading || controller.ownerLoading}
      >
        <AgentProjectContent controller={controller} />
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
