import { useEffect, useState } from 'react';
import { Loading } from '@/client/components/loading';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { EventAgentDetail, TriggerInspection } from './event-agent-detail';
import { EventAgentHistory } from './event-agent-history';
import { SavedEventEditor } from './saved-event-editor';
import type { EventAgent } from './types';
import type { useAgentsController } from './use-agents-controller';

function appendRetained(
  previous: EventAgent['retainedTriggers'],
  incoming: EventAgent['retainedTriggers'],
  initial: EventAgent['retainedTriggers']
) {
  const initialIds = new Set(initial.map((trigger) => trigger.id));
  const records = new Map(
    [...previous, ...incoming]
      .filter((trigger) => !initialIds.has(trigger.id))
      .map((trigger) => [trigger.id, trigger])
  );
  return [...records.values()];
}
export function RetainedContinuation({ agent }: { agent: EventAgent }) {
  return (
    <RetainedPageSession
      key={`${agent.projectId}:${agent.id}:${agent.managementRevision}`}
      agent={agent}
    />
  );
}
function RetainedPageSession({ agent }: { agent: EventAgent }) {
  const [cursor, setCursor] = useState<string>();
  const [records, setRecords] = useState<EventAgent['retainedTriggers']>([]);
  const [next, setNext] = useState(agent.retainedNextCursor);
  const utils = trpc.useUtils();
  const page = trpc.automation.get.useQuery(
    { projectId: agent.projectId, agentId: agent.id, retainedCursor: cursor },
    { enabled: !!cursor }
  );
  const stale =
    !!cursor && !!page.data && page.data.managementRevision !== agent.managementRevision;
  useEffect(() => {
    if (!(cursor && page.data) || page.data.managementRevision !== agent.managementRevision) {
      return;
    }
    const current = page.data;
    setRecords((previous) =>
      appendRetained(previous, current.retainedTriggers, agent.retainedTriggers)
    );
    setNext(current.retainedNextCursor);
  }, [cursor, page.data, agent.managementRevision, agent.retainedTriggers]);
  return (
    <div className="space-y-3">
      {records.length > 0 && (
        <section className="space-y-3" aria-label="More retained triggers">
          {records.map((trigger) => (
            <TriggerInspection key={trigger.id} trigger={trigger} />
          ))}
        </section>
      )}
      {cursor && page.isFetching && (
        <p role="status" className="inline-flex items-center gap-2 text-sm">
          <Spinner className="size-3" aria-hidden="true" />
          Loading retained triggers…
        </p>
      )}
      {cursor && page.error && (
        <p role="alert" className="text-sm">
          Couldn't load retained triggers. {page.error.message}
        </p>
      )}
      {stale && !page.isFetching && (
        <div role="status" className="space-y-2 text-sm">
          <p>
            The saved definition changed. Refresh the automation before inspecting more retained
            records.
          </p>
          <Button
            variant="outline"
            onClick={() =>
              void utils.automation.get.invalidate({
                projectId: agent.projectId,
                agentId: agent.id,
              })
            }
          >
            Refresh automation
          </Button>
        </div>
      )}
      {(next || (cursor && page.error)) && (
        <Button
          variant="outline"
          disabled={page.isFetching || stale}
          onClick={() => {
            if (page.error) {
              void page.refetch();
            } else if (next) {
              setCursor(next);
            }
          }}
        >
          {page.error ? 'Retry retained triggers' : 'Load more retained triggers'}
        </Button>
      )}
    </div>
  );
}
export function EventAgentSelection({
  controller,
}: {
  controller: ReturnType<typeof useAgentsController>;
}) {
  const { event, mode, project } = controller;
  if (mode === 'edit' && event.data) {
    return (
      <>
        {event.error && (
          <p role="alert" className="text-sm">
            Couldn't refresh saved definition. {event.error.message}. Your draft is preserved.
          </p>
        )}
        <SavedEventEditor
          agent={event.data}
          onCancel={() => controller.setMode('detail')}
          onSaved={controller.eventSaved}
        />
      </>
    );
  }
  if (event.error && (!event.data || event.error.data?.code === 'NOT_FOUND')) {
    return (
      <div role="alert" className="space-y-3 text-sm">
        <p>
          {event.error.data?.code === 'NOT_FOUND'
            ? 'Automation not found in this project.'
            : `Couldn't load event-triggered automation. ${event.error.message}`}
        </p>
        <Button variant="outline" onClick={() => void event.refetch()}>
          Retry automation
        </Button>
      </div>
    );
  }
  if (event.isLoading) {
    return <Loading size="compact" message="Loading event-triggered automation…" />;
  }
  if (!event.data) {
    return <p className="text-sm">Select an automation from the project list.</p>;
  }
  return (
    <>
      {event.error && (
        <p role="alert" className="text-sm">
          Couldn't refresh event-triggered automation. {event.error.message}
          <Button variant="outline" onClick={() => void event.refetch()}>
            Retry automation
          </Button>
        </p>
      )}
      <EventAgentDetail
        agent={event.data}
        archived={project.isArchived}
        saved={controller.savedEvent}
        onEdit={() => controller.setMode('edit')}
        onDeleted={controller.eventDeleted}
      >
        <RetainedContinuation key={`${project.id}:event:${event.data.id}`} agent={event.data} />
      </EventAgentDetail>
      <EventAgentHistory
        key={`${project.id}:event-history:${event.data.id}`}
        agent={event.data}
        projectSlug={project.slug}
        archived={!!project.isArchived}
      />
    </>
  );
}
