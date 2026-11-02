import { useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { EventAgentDetail, TriggerInspection } from './event-agent-detail';
import { SavedEventEditor } from './saved-event-editor';
import type { EventAgent } from './types';
import type { useAgentsController } from './use-agents-controller';

function RetainedContinuation({ agent }: { agent: EventAgent }) {
  const [cursor, setCursor] = useState<string>();
  const page = trpc.agent.get.useQuery(
    { projectId: agent.projectId, agentId: agent.id, retainedCursor: cursor },
    { enabled: !!cursor, retry: false }
  );
  const next = cursor ? page.data?.retainedNextCursor : agent.retainedNextCursor;
  return (
    <div className="space-y-3">
      {cursor && page.data && (
        <section className="space-y-3" aria-label="More retained triggers">
          {page.data.retainedTriggers.map((trigger) => (
            <TriggerInspection key={trigger.id} trigger={trigger} />
          ))}
        </section>
      )}
      {page.error && (
        <p role="alert" className="text-sm">
          Could not load retained triggers: {page.error.message}
          <Button variant="outline" onClick={() => void page.refetch()}>
            Retry retained triggers
          </Button>
        </p>
      )}
      {next && (
        <Button variant="outline" disabled={page.isFetching} onClick={() => setCursor(next)}>
          Load more retained triggers
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
            Could not refresh saved definition: {event.error.message}. Your draft is preserved.
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
            ? 'Agent not found in this project.'
            : `Could not load event agent: ${event.error.message}`}
        </p>
        <Button variant="outline" onClick={() => void event.refetch()}>
          Retry agent
        </Button>
      </div>
    );
  }
  if (event.isLoading) {
    return (
      <p role="status" className="text-sm">
        Loading event agent…
      </p>
    );
  }
  if (!event.data) {
    return <p className="text-sm">Select an agent from the project list.</p>;
  }
  return (
    <>
      {event.error && (
        <p role="alert" className="text-sm">
          Could not refresh event agent: {event.error.message}
          <Button variant="outline" onClick={() => void event.refetch()}>
            Retry agent
          </Button>
        </p>
      )}
      <EventAgentDetail
        agent={event.data}
        archived={project.isArchived}
        saved={controller.savedEvent}
        onEdit={() => controller.setMode('edit')}
      >
        <RetainedContinuation key={`${project.id}:event:${event.data.id}`} agent={event.data} />
      </EventAgentDetail>
    </>
  );
}
