import { z } from 'zod';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AgentSpecification } from '@/shared/agent-proposal';
import { agentTriggerInputSchema } from '@/shared/schemas/agent-definition.schema';
import type { AgentProposalDraft } from './agent-proposal-draft';

type TriggerDraft = AgentProposalDraft['triggers'][number];
function draftSource(
  trigger: TriggerDraft,
  fallback: AgentSpecification['triggers'][number] | undefined
) {
  try {
    const fields = z.record(z.string(), z.unknown()).parse(JSON.parse(trigger.event));
    const parsed = agentTriggerInputSchema.safeParse({
      ...fields,
      description: trigger.description,
    });
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}
export function AgentTriggerEditor({
  trigger,
  original,
  index,
  id,
  sourceNames,
  onChange,
}: {
  trigger: TriggerDraft;
  original: AgentSpecification['triggers'][number] | undefined;
  index: number;
  id: string;
  sourceNames: Record<string, string>;
  onChange: (field: 'description' | 'filterInstructions' | 'event', value: string) => void;
}) {
  const source = draftSource(trigger, original);
  const resources =
    source?.type === 'SLACK_MESSAGE'
      ? source.config.channelIds
      : source?.type === 'GITHUB_ISSUE'
        ? source.config.repositoryIds
        : [];
  const label =
    source?.type === 'SLACK_MESSAGE'
      ? 'Slack messages'
      : source?.type === 'GITHUB_ISSUE'
        ? 'GitHub issues'
        : 'Schedule';
  return (
    <div className="min-w-0 space-y-3 rounded-lg border p-3">
      <p className="break-words text-sm font-medium">
        {label}
        {resources.length > 0 &&
          ` · ${resources.map((resource) => sourceNames[`${source?.connectionId}:${resource}`] ?? resource).join(', ')}`}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-event-${index}`}>Event description</Label>
        <Textarea
          id={`${id}-event-${index}`}
          aria-label={`Event description ${index + 1}`}
          value={trigger.description}
          onChange={(event) => onChange('description', event.target.value)}
          rows={2}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-filter-${index}`}>When to investigate</Label>
        <Textarea
          id={`${id}-filter-${index}`}
          aria-label={`Filter ${index + 1}`}
          placeholder="Every matching event"
          value={trigger.filterInstructions}
          onChange={(event) => onChange('filterInstructions', event.target.value)}
          rows={3}
        />
      </div>
      <details className="min-w-0 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Event settings</summary>
        <Textarea
          aria-label={`Event settings ${index + 1}`}
          className="mt-2 max-w-full font-mono text-xs"
          value={trigger.event}
          onChange={(event) => onChange('event', event.target.value)}
          rows={8}
        />
      </details>
    </div>
  );
}
