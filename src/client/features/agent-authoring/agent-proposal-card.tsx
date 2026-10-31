import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { withOccurrenceKeys } from '@/client/lib/list-keys';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  type AgentProposal,
  type AgentProposalReference,
  type createAgentFromProposalSchema,
} from '@/shared/agent-proposal';

type CreateInput = z.infer<typeof createAgentFromProposalSchema>;
import { draftFrom, reconcileDraft, specificationFromDraft } from './agent-proposal-draft';
import { AgentTriggerEditor } from './agent-trigger-editor';

type EditorProps = {
  proposal: AgentProposal;
  onCreate: (input: CreateInput) => Promise<AgentProposal>;
};
function heading(hasAgent: boolean, editing: boolean) {
  if (!hasAgent) {
    return 'Proposed agent';
  }
  return editing ? 'Edit agent' : 'Agent created';
}
function useProposalEditor({ proposal, onCreate }: EditorProps) {
  const [draft, setDraft] = useState(() => draftFrom(proposal));
  const [created, setCreated] = useState<AgentProposal>();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [eventConflict, setEventConflict] = useState(false);
  const latest = created && created.revision >= proposal.revision ? created : proposal;
  const accepted = latest.agentDefinitionId ? latest : null;
  const stale = draft.revision !== latest.revision;
  const updateTrigger = (
    index: number,
    field: 'description' | 'filterInstructions' | 'event',
    value: string
  ) =>
    setDraft((current) => ({
      ...current,
      triggers: current.triggers.map((trigger, i) =>
        i === index ? { ...trigger, [field]: value } : trigger
      ),
    }));

  async function create() {
    if (submitting.current || stale) {
      return;
    }
    setError(undefined);
    let input: CreateInput;
    try {
      input = {
        workspaceId: proposal.workspaceId,
        proposalId: proposal.id,
        revision: draft.revision,
        specification: specificationFromDraft(draft),
      };
    } catch {
      setError(
        'Check the name, instructions, and event settings. Event settings must be valid configuration JSON.'
      );
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      setCreated(await onCreate(input));
      setEditing(false);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Could not create this agent. Try again.'
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function loadLatest(discardLocalEvents = false) {
    try {
      setDraft(reconcileDraft(draft, latest, discardLocalEvents));
      setError(undefined);
      setEventConflict(false);
    } catch (error) {
      setEventConflict(true);
      setError(
        error instanceof Error
          ? error.message
          : 'Review your local event edits before loading the latest proposal.'
      );
    }
  }
  return {
    draft,
    setDraft,
    latest,
    accepted,
    stale,
    updateTrigger,
    create,
    busy,
    error,
    setError,
    editing,
    setEditing,
    eventConflict,
    loadLatest,
  };
}

export function AgentProposalEditor(props: EditorProps) {
  const id = useId();
  const {
    draft,
    setDraft,
    latest,
    accepted,
    stale,
    updateTrigger,
    create,
    busy,
    error,
    setError,
    editing,
    setEditing,
    eventConflict,
    loadLatest,
  } = useProposalEditor(props);
  return (
    <section
      aria-label="Agent configuration"
      className="my-3 min-w-0 rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
    >
      <div className="mb-4 space-y-1">
        <h3 className="text-base font-semibold">{heading(Boolean(accepted), editing)}</h3>
        <p className="text-xs text-muted-foreground">
          {accepted
            ? 'Configuration saved. Event listening and automatic runs are not available yet.'
            : 'Review or edit the configuration, then create your agent. Event listening and automatic runs are not available yet.'}
        </p>
      </div>
      {accepted && !editing ? (
        <div className="space-y-2 text-sm">
          <p className="font-medium break-words">{accepted.specification.name}</p>
          <p className="whitespace-pre-wrap break-words">{accepted.specification.instructions}</p>
          {withOccurrenceKeys(
            accepted.specification.triggers,
            (trigger) => trigger.description
          ).map(({ item: trigger, key }) => (
            <p key={key} className="break-words text-muted-foreground">
              {trigger.description}
            </p>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(draftFrom(latest));
              setEditing(true);
              setError(undefined);
            }}
          >
            Edit agent
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <fieldset disabled={busy || stale} className="min-w-0 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                aria-label="Name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-instructions`}>What the agent should do</Label>
              <Textarea
                id={`${id}-instructions`}
                aria-label="Instructions"
                value={draft.instructions}
                onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                rows={4}
              />
            </div>
            {draft.triggers.map((trigger, index) => (
              <AgentTriggerEditor
                key={trigger.key}
                trigger={trigger}
                original={latest.specification.triggers[index]}
                index={index}
                id={id}
                sourceNames={latest.sourceNames}
                onChange={(field, value) => updateTrigger(index, field, value)}
              />
            ))}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Execution settings</summary>
              <Textarea
                aria-label="Execution settings"
                className="mt-2 font-mono text-xs"
                value={draft.executionConfig}
                onChange={(event) => setDraft({ ...draft, executionConfig: event.target.value })}
                rows={5}
              />
            </details>
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {stale ? (
            <div className="space-y-2">
              <p role="status" className="text-sm">
                A newer proposal is available. Load it to combine it with your edits; review any
                fields you both changed.
              </p>
              <LatestProposalButton eventConflict={eventConflict} onLoad={loadLatest} />
            </div>
          ) : (
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : accepted ? 'Save changes' : 'Create agent'}
            </Button>
          )}
        </form>
      )}
    </section>
  );
}

function LatestProposalButton({
  eventConflict,
  onLoad,
}: {
  eventConflict: boolean;
  onLoad: (discard: boolean) => void;
}) {
  return (
    <Button type="button" onClick={() => onLoad(eventConflict)}>
      {eventConflict ? 'Discard local event edits and load latest' : 'Load latest proposal'}
    </Button>
  );
}

export function AgentProposalCard({ reference }: { reference: AgentProposalReference }) {
  const input = { workspaceId: reference.workspaceId, proposalId: reference.proposalId };
  const query = trpc.agent.getProposal.useQuery(input, { refetchOnWindowFocus: false });
  const mutation = trpc.agent.create.useMutation({
    onError: (error) => toast.error(error.message),
  });
  const update = trpc.agent.update.useMutation({ onError: (error) => toast.error(error.message) });
  const utils = trpc.useUtils();
  const { refetch } = query;
  useEffect(() => {
    if (reference.revision && query.data && reference.revision > query.data.revision) {
      void refetch();
    }
  }, [reference.revision, query.data, refetch]);
  if (!query.data) {
    return (
      <p role={query.error ? 'alert' : 'status'} className="my-3 text-sm">
        {query.error?.message ?? 'Loading agent proposal…'}
      </p>
    );
  }
  return (
    <AgentProposalEditor
      proposal={query.data}
      onCreate={async (value) => {
        let result: AgentProposal;
        try {
          result = await (query.data?.agentDefinitionId ? update : mutation).mutateAsync(value);
        } catch (error) {
          await refetch();
          throw error;
        }
        utils.agent.getProposal.setData(input, result);
        return result;
      }}
    />
  );
}
