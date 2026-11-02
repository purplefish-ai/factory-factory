import type { EventDraftValidation, EventProjectSources } from './types';

export function EventDraftPreview({ preview }: { preview: EventDraftValidation }) {
  const execution = preview.execution;
  return (
    <section aria-label="Draft preview" className="min-w-0 space-y-2 rounded-lg border p-3 text-sm">
      <h3 className="font-medium">Draft preview</h3>
      <p>This preview grants no activation, execution or account authority.</p>
      {preview.triggers.map((trigger) => (
        <p key={trigger.index}>
          Event {trigger.index + 1}: {trigger.capability.status} · {trigger.capability.explanation}
        </p>
      ))}
      {execution.status === 'VALIDATED' ? (
        <dl className="space-y-1 break-words">
          <div>
            <dt>Provider</dt>
            <dd>
              {execution.intent.provider} · {execution.intent.providerIntent}
            </dd>
          </div>
          <div>
            <dt>Requested model</dt>
            <dd>
              {execution.intent.requestedModel} · {execution.intent.modelIntent}
            </dd>
          </div>
          <div>
            <dt>Confirmed model</dt>
            <dd>{execution.intent.model}</dd>
          </div>
          <div>
            <dt>Resolved effort</dt>
            <dd>
              {execution.intent.reasoningEffort ?? 'None (null)'} · {execution.intent.effortIntent}
            </dd>
          </div>
          <div>
            <dt>Effort normalization</dt>
            <dd>{execution.intent.effortNormalization}</dd>
          </div>
        </dl>
      ) : (
        <p role="status">
          {execution.status}: {execution.explanation}
          {execution.status === 'UNAVAILABLE'
            ? ' Retry validation when discovery is available.'
            : ''}
        </p>
      )}
    </section>
  );
}
export function EventSourcesPreview({ sources }: { sources: EventProjectSources }) {
  return (
    <section
      aria-label="Project sources"
      className="min-w-0 space-y-2 rounded-lg border p-3 text-sm"
    >
      <h3 className="font-medium">Project sources</h3>
      {'error' in sources.github ? (
        <p>GitHub: {sources.github.error}</p>
      ) : (
        <p className="break-words">
          GitHub: {sources.github.repository.name} ·{' '}
          {sources.github.repository.labels.join(', ') || 'No labels'}
        </p>
      )}
      {sources.slack.connections.map((connection) => (
        <p key={connection.id} className="break-words">
          Slack: {connection.name} · {connection.id}
        </p>
      ))}
      {sources.slack.channels?.map((channel) => (
        <p key={channel.id}>
          {channel.name} · {channel.id}
        </p>
      ))}
      <p className="text-xs text-muted-foreground">
        Names and stored IDs do not prove access. Validate the current complete draft explicitly.
      </p>
    </section>
  );
}
