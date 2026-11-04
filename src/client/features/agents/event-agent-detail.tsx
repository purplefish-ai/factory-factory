import { Button } from '@/components/ui/button';
import type { EventAgent } from './types';

type Trigger = EventAgent['retainedTriggers'][number];
export function TriggerInspection({ trigger }: { trigger: Trigger }) {
  return (
    <article className="min-w-0 space-y-2 rounded-lg border p-3 text-sm">
      <h4 className="break-words font-medium">
        {trigger.configuration?.description ?? 'Configuration unavailable'}
      </h4>
      <p className="break-words text-xs text-muted-foreground">{trigger.id}</p>
      <p>
        {trigger.isConfigured === true
          ? 'Configured'
          : trigger.isConfigured === false
            ? 'Removed'
            : 'Unknown membership'}{' '}
        · {trigger.activationState} · {trigger.isEnabled ? 'Enabled' : 'Disabled'}
      </p>
      <p>
        Trigger revision {trigger.triggerRevision} · Activation generation{' '}
        {trigger.activationGeneration}
      </p>
      <p>
        {trigger.capability.status}: {trigger.capability.explanation}
      </p>
      <p className="break-words">Source: {trigger.sourceName ?? 'Name unavailable'}</p>
      <p>
        Source health:{' '}
        {trigger.sourceHealth
          ? `${trigger.sourceHealth.state}${trigger.sourceHealth.reasonCode ? ` · ${trigger.sourceHealth.reasonCode}` : ''}`
          : 'Unavailable'}
      </p>
      {trigger.configuration && (
        <details>
          <summary className="cursor-pointer">Stored event configuration</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(trigger.configuration, null, 2)}
          </pre>
        </details>
      )}
    </article>
  );
}
export function EventAgentInspection({ agent }: { agent: EventAgent }) {
  return (
    <div className="min-w-0 space-y-5">
      <section className="space-y-2">
        <h3 className="font-medium">Instructions</h3>
        <p className="whitespace-pre-wrap break-words text-sm">{agent.instructions}</p>
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Saved execution settings</h3>
        {agent.executionConfig ? (
          <pre className="whitespace-pre-wrap break-words text-xs">
            {JSON.stringify(agent.executionConfig, null, 2)}
          </pre>
        ) : (
          <p className="text-sm">
            Execution configuration unavailable. A complete replacement is required.
          </p>
        )}
      </section>
      <section className="space-y-3">
        <h3 className="font-medium">Configured triggers</h3>
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
        <h3 className="font-medium">Retained trigger inspection</h3>
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
  archived = false,
  saved = false,
  children,
}: {
  agent: EventAgent;
  onEdit: () => void;
  archived?: boolean;
  saved?: boolean;
  children?: React.ReactNode;
}) {
  const paused = agent.configuredTriggers.some(
    (trigger) => trigger.activationState === 'PAUSED' || !trigger.isEnabled
  );
  return (
    <div className="min-w-0 space-y-6">
      <header className="space-y-3">
        <h2 className="break-words text-xl font-semibold">{agent.name}</h2>
        <p className="text-sm">
          Event agent · Definition {agent.isEnabled ? 'enabled' : 'paused'} · Management revision{' '}
          {agent.managementRevision}
        </p>
        <Button onClick={onEdit} disabled={archived}>
          Edit Agent
        </Button>
        {archived && (
          <p className="text-sm text-muted-foreground">
            Archived project: saved details are readable; editing and previews require an active
            project.
          </p>
        )}
      </header>
      {saved && (
        <p role="status" className="text-sm">
          Configuration saved.
          {paused
            ? ' Triggers are paused; re-enabling is needed before they can listen. Re-enabling is not available on this page.'
            : ' Existing trigger runtime state is shown below.'}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Definition state, trigger activation, capability and source health are separate facts.
        Supported configuration does not prove a trigger is listening.
      </p>
      <EventAgentInspection agent={agent} />
      {children}
    </div>
  );
}
