import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EventAgentActivation } from './event-agent-activation';
import { EventAgentDelete } from './event-agent-delete';
import { EventSourceRecovery } from './event-source-reset';
import { describeAutomationState, EventTriggerCard } from './event-trigger-status';
import type { EventAgent } from './types';

type Trigger = EventAgent['retainedTriggers'][number];
/** A retained or configured trigger record, as shown on the detail and in the editor. */
export function TriggerInspection({ trigger }: { trigger: Trigger }) {
  return <EventTriggerCard trigger={trigger} />;
}

function ExecutionSummary({ config }: { config: NonNullable<EventAgent['executionConfig']> }) {
  const rows = [
    ['Provider', config.provider],
    ['Model', config.model],
    ['Reasoning effort', config.reasoningEffort],
  ] as const;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value ?? 'Your default'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EventAgentInspection({
  agent,
  archived = false,
  showSourceRecovery = false,
}: {
  agent: EventAgent;
  archived?: boolean;
  /** Offer Reset source for GitHub sources that need recovery (the saved detail only). */
  showSourceRecovery?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-5">
      <section className="space-y-2">
        <h3 className="font-medium">Instructions</h3>
        <p className="whitespace-pre-wrap break-words text-sm">{agent.instructions}</p>
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Execution settings</h3>
        {agent.executionConfig ? (
          <>
            <ExecutionSummary config={agent.executionConfig} />
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Saved execution settings JSON</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words">
                {JSON.stringify(agent.executionConfig, null, 2)}
              </pre>
            </details>
          </>
        ) : (
          <p className="text-sm">
            Execution configuration unavailable. A complete replacement is required.
          </p>
        )}
      </section>
      <section className="space-y-3">
        <h3 className="font-medium">Triggers</h3>
        {showSourceRecovery && <EventSourceRecovery agent={agent} archived={archived} />}
        {agent.configurationMembership === 'UNKNOWN' && (
          <p className="text-sm">
            Exact membership is unknown, including records beyond the retained page. Inspection
            cannot reconstruct an editable specification.
          </p>
        )}
        {agent.configuredTriggers.map((trigger) => (
          <TriggerInspection key={trigger.id} trigger={trigger} />
        ))}
        {agent.configurationMembership === 'KNOWN' && agent.configuredTriggers.length === 0 && (
          <p className="text-sm">No configured triggers</p>
        )}
      </section>
      <section className="space-y-3">
        <h3 className="font-medium">Retained trigger records</h3>
        {agent.retainedTriggers.map((trigger) => (
          <TriggerInspection key={trigger.id} trigger={trigger} />
        ))}
        {agent.retainedTriggers.length === 0 && (
          <p className="text-sm">No retained records on this page</p>
        )}
      </section>
    </div>
  );
}

export function EventAgentDetail({
  agent,
  onEdit,
  onDeleted,
  archived = false,
  saved = false,
  children,
}: {
  agent: EventAgent;
  onEdit: () => void;
  /** Offers Delete; called once the automation is deleted, to return to the list. */
  onDeleted?: (agentId: string) => void;
  archived?: boolean;
  saved?: boolean;
  children?: React.ReactNode;
}) {
  const state = describeAutomationState(agent.configuredTriggers);
  return (
    <div className="min-w-0 space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="min-w-0 break-words text-xl font-semibold tracking-tight">{agent.name}</h2>
          <Badge variant="secondary">{state}</Badge>
        </div>
        <EventAgentActivation
          key={`${agent.projectId}:${agent.id}`}
          agent={agent}
          archived={archived}
        >
          <Button variant="outline" size="sm" onClick={onEdit} disabled={archived}>
            Edit automation
          </Button>
          {onDeleted && (
            <EventAgentDelete agent={agent} archived={archived} onDeleted={onDeleted} />
          )}
        </EventAgentActivation>
        {archived && (
          <p className="text-sm text-muted-foreground">
            Archived project: saved details are readable; editing, enabling, pausing, resetting a
            source and deleting require an active project.
          </p>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-2 break-words">
            Event-triggered automation {agent.id} · Definition{' '}
            {agent.isEnabled ? 'enabled' : 'disabled'} · Management revision{' '}
            {agent.managementRevision} · Definition revision {agent.definitionRevision}
          </p>
        </details>
      </header>
      {saved && (
        <p role="status" className="text-sm">
          Configuration saved.
          {state === 'Paused'
            ? ' The automation is paused. Enable it to start listening.'
            : ' Each trigger’s current state is shown below.'}
        </p>
      )}
      <EventAgentInspection agent={agent} archived={archived} showSourceRecovery />
      {children}
    </div>
  );
}
