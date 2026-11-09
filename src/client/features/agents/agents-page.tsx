import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { z } from 'zod';
import { Loading } from '@/client/components/loading';
import { getAgentRouteKind, type AgentKind } from '@/client/lib/project-navigation';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AgentDetail } from './agent-detail';
import { AgentForm } from './agent-form';
import { AgentRunHistoryQuery } from './agent-run-history';
import { AgentsDashboardShell } from './agents-dashboard-shell';
import { EventAgentCreate } from './event-agent-create';
import { EventAgentSelection } from './event-agent-selection';
import type { AgentProject } from './types';
import { useAgentsController } from './use-agents-controller';

const editorRevealState = z.object({
  revealAgentEditor: z.boolean().optional(),
  createAgent: z.boolean().optional(),
});

type Controller = ReturnType<typeof useAgentsController>;
type EventCreationRenderer = (onCancel: () => void) => ReactNode;
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
      label="Retry automation"
      retry={() => {
        void task.refetch();
      }}
    >
      {task.error.data?.code === 'NOT_FOUND'
        ? 'Automation not found. This automation is no longer available.'
        : `Couldn't ${refresh ? 'refresh' : 'load'} automation: ${task.error.message}`}
    </RequestError>
  );
}
function AgentSelectionContent({
  controller,
  renderEventCreation,
}: {
  controller: Controller;
  renderEventCreation: EventCreationRenderer;
}) {
  const { id, project, mode } = controller;
  if (controller.wrongOwner) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Automation not found in this project.
      </p>
    );
  }
  if (mode === 'create-event') {
    return (
      <EventAgentCreate>{renderEventCreation(() => controller.setMode('detail'))}</EventAgentCreate>
    );
  }
  if (mode === 'create' && project) {
    return (
      <>
        <div>
          <h2 className="text-xl font-semibold">Create automation</h2>
        </div>
        <AgentForm
          key={`create-${project.id}`}
          onSave={controller.save}
          onCancel={() => controller.setMode('detail')}
        />
      </>
    );
  }
  if (!id && mode === 'detail') {
    if (controller.list.error || controller.events.error) {
      return <p className="text-sm">Select an available automation or retry the failed list.</p>;
    }
    if (controller.list.isLoading || controller.events.isLoading) {
      return <Loading size="compact" message="Loading automations…" />;
    }
  }
  if (controller.kind === 'event') {
    return <EventAgentSelection controller={controller} />;
  }
  return <ScheduledAgentSelection controller={controller} />;
}
function ScheduledAgentSelection({ controller }: { controller: Controller }) {
  const { id, task, project, mode } = controller;
  // Keep mounted editors and their drafts during background query failures.
  if (mode === 'edit' && task.data) {
    return (
      <>
        <h2 className="text-xl font-semibold">Edit automation</h2>
        <AgentRequestError task={task} refresh />
        <AgentForm
          key={`edit-${project.id}:scheduled:${task.data.id}`}
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
    return <Loading size="compact" message="Loading automation…" />;
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
      <h2 className="text-lg font-semibold">Automate recurring work</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Create an automation with instructions and a schedule.
      </p>
    </div>
  );
}
function AgentsPageSession({
  project: routeProject,
  kind,
  renderEventCreation,
  revealEditorOnMount,
}: {
  project: AgentProject;
  revealEditorOnMount: boolean;
  kind: AgentKind;
  renderEventCreation: EventCreationRenderer;
}) {
  const controller = useAgentsController(routeProject, kind);
  const { id, list, project, mode, pending, actionError } = controller;
  return (
    <>
      <AgentsDashboardShell
        projectSlug={project.slug}
        revealEditorOnMount={revealEditorOnMount}
        agents={
          list.data || controller.events.data
            ? [
                ...(list.data ?? []),
                ...(controller.events.data?.pages.flatMap((page) =>
                  page.items.map((item) => ({ ...item, kind: 'event' as const }))
                ) ?? []),
              ]
            : undefined
        }
        selectedKind={kind}
        continuation={
          controller.events.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              disabled={controller.events.isFetchingNextPage}
              onClick={() => void controller.events.fetchNextPage()}
            >
              Load more event-triggered automations
            </Button>
          ) : undefined
        }
        selectedAgentId={mode === 'create' || mode === 'create-event' ? undefined : id}
        isLoading={list.isLoading || controller.events.isLoading}
        error={
          [
            list.error ? `Couldn't load scheduled automations. ${list.error.message}` : '',
            controller.events.error
              ? `Couldn't load event-triggered automations. ${controller.events.error.message}`
              : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined
        }
        onRetry={() => {
          void list.refetch();
          void controller.events.refetch();
        }}
        onCreate={controller.startCreate}
        createDisabled={controller.createDisabled}
        onAgentSelect={controller.selectAgent}
      >
        <AgentSelectionContent controller={controller} renderEventCreation={renderEventCreation} />
      </AgentsDashboardShell>
      <ConfirmDialog
        open={controller.deleteOpen}
        onOpenChange={(open) => {
          if (!pending) {
            controller.setDeleteOpen(open);
          }
        }}
        title="Delete automation?"
        description={`The automation definition and run history will be permanently deleted. Generated workspaces and chats are kept. This cannot be undone.${actionError ? ` ${actionError}` : ''}`}
        confirmText="Delete"
        variant="destructive"
        onConfirm={controller.deleteAgent}
        isPending={pending}
      />
    </>
  );
}

/** Navigation creates a fresh editing session; polling keeps the existing draft. */
export function AgentsPage({
  project,
  renderEventCreation,
}: {
  project: AgentProject;
  renderEventCreation: EventCreationRenderer;
}) {
  const location = useLocation();
  const kind = getAgentRouteKind(location.search);
  const revealState = editorRevealState.safeParse(location.state);
  const revealEditor =
    revealState.success &&
    (revealState.data.revealAgentEditor === true || revealState.data.createAgent === true);
  if (!kind) {
    return (
      <p role="alert" className="p-6 text-sm">
        Invalid automation kind. Use a single scheduled or event selection.
      </p>
    );
  }
  return (
    <AgentsPageSession
      key={`${project.id}:${kind}:${location.key}`}
      revealEditorOnMount={revealEditor}
      project={project}
      kind={kind}
      renderEventCreation={renderEventCreation}
    />
  );
}
