import { useId, useState } from 'react';
import { AgentTriggerEditor } from '@/client/features/agent-authoring';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { EventAgentInspection } from './event-agent-detail';
import { EventDraftPreview, EventSourcesPreview } from './event-agent-preview';
import { useEventAgentEditor, type EventAgentEditorProps } from './use-event-agent-editor';

export function EventAgentEditor(props: EventAgentEditorProps) {
  const editor = useEventAgentEditor(props);
  const { draft } = editor;
  const id = useId();
  const inspectOnly = !(draft || editor.replacementMode);
  return (
    <section className="min-w-0 space-y-5" aria-label="Saved event editor">
      <h2 className="text-xl font-semibold">Edit Agent</h2>
      <p className="text-sm break-words">
        {editor.baseline.name} · Saved management revision {editor.baseline.managementRevision}
      </p>
      {(inspectOnly || editor.replacementMode) && <EventAgentInspection agent={editor.baseline} />}
      {inspectOnly ? (
        <div className="space-y-3">
          <p className="text-sm">
            The exact saved specification is unavailable. Review existing facts, then explicitly
            replace the whole configuration. Retained records are inspection data.
          </p>
          <Button onClick={editor.startReplacement}>Replace complete specification</Button>
          <Button variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <form
          className="min-w-0 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void editor.attempt('save');
          }}
        >
          <fieldset
            disabled={editor.busy === 'save' || editor.busy === 'reload'}
            className="min-w-0 space-y-4"
          >
            {editor.replacementMode ? (
              <div className="space-y-2">
                <Label htmlFor={`${id}-replacement`}>Full saved specification JSON</Label>
                <p className="text-xs text-muted-foreground">
                  Supply the complete intended name, instructions, executionConfig and triggers.
                  This blank input does not infer membership or repair stored fields automatically.
                </p>
                <Textarea
                  id={`${id}-replacement`}
                  aria-label="Full saved specification JSON"
                  className="max-w-full font-mono text-xs"
                  rows={16}
                  value={editor.replacement}
                  onChange={(event) => editor.updateReplacement(event.target.value)}
                />
              </div>
            ) : (
              draft && <SavedEventFields editor={editor} id={id} />
            )}
            <p className="text-xs text-muted-foreground">
              Name-only edits preserve activation for known unchanged members. Task or execution
              edits pause triggers. Changed, reintroduced or unknown members pause and advance
              trigger revisions. Unclaimed queued work is cancelled; claimed snapshots continue.
              Re-enabling is needed for paused triggers and is not available here.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">{editor.busy === 'save' ? 'Saving…' : 'Save changes'}</Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void editor.attempt('validate')}
              >
                Validate draft
              </Button>
              <Button type="button" variant="outline" onClick={props.onCancel}>
                Cancel
              </Button>
            </div>
          </fieldset>
        </form>
      )}
      {!inspectOnly && <SourceControls editor={editor} id={id} />}
      <EditorFeedback editor={editor} reloadAvailable={!!props.onReload} />
    </section>
  );
}

type Editor = ReturnType<typeof useEventAgentEditor>;
function SavedEventFields({ editor, id }: { editor: Editor; id: string }) {
  const { draft, updateDraft } = editor;
  if (!draft) {
    return null;
  }
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          value={draft.name}
          onChange={(event) => updateDraft({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-instructions`}>Instructions</Label>
        <Textarea
          id={`${id}-instructions`}
          aria-label="Instructions"
          rows={5}
          value={draft.instructions}
          onChange={(event) => updateDraft({ ...draft, instructions: event.target.value })}
        />
      </div>
      {draft.triggers.map((trigger, index) => (
        <div key={trigger.key} className="min-w-0 space-y-2">
          <AgentTriggerEditor
            id={id}
            trigger={trigger}
            original={editor.baseline.specification?.triggers.find(
              (item) => item.id === trigger.savedId
            )}
            index={index}
            sourceNames={{}}
            onChange={(field, value) =>
              updateDraft({
                ...draft,
                triggers: draft.triggers.map((item, i) =>
                  i === index ? { ...item, [field]: value } : item
                ),
              })
            }
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={index === 0}
              onClick={() => {
                const next = [...draft.triggers];
                const previous = next[index - 1];
                const current = next[index];
                if (!(previous && current)) {
                  return;
                }
                [next[index - 1], next[index]] = [current, previous];
                updateDraft({ ...draft, triggers: next });
              }}
            >
              Move event {index + 1} up
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                updateDraft({
                  ...draft,
                  triggers: draft.triggers.filter((item) => item.key !== trigger.key),
                })
              }
            >
              Remove event {index + 1}
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          updateDraft({
            ...draft,
            triggers: [
              ...draft.triggers,
              {
                key: crypto.randomUUID(),
                savedId: undefined,
                description: '',
                filterInstructions: '',
                event: '{}',
              },
            ],
          })
        }
      >
        Add event
      </Button>
      <div className="space-y-2">
        <Label htmlFor={`${id}-execution`}>Execution settings JSON</Label>
        <Textarea
          id={`${id}-execution`}
          aria-label="Execution settings"
          className="max-w-full font-mono text-xs"
          rows={5}
          value={draft.executionConfig}
          onChange={(event) => updateDraft({ ...draft, executionConfig: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Omitted provider, model and reasoningEffort stay inherited. Preview does not write
          discovered defaults into this draft.
        </p>
      </div>
    </>
  );
}
function SourceControls({ editor, id }: { editor: Editor; id: string }) {
  const [connectionId, setConnectionId] = useState('');
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={`${id}-connection`}>Slack connection ID (optional)</Label>
      <Input
        id={`${id}-connection`}
        disabled={editor.busy === 'save' || editor.busy === 'reload'}
        value={connectionId}
        onChange={(event) => {
          editor.sourceSelectionChanged();
          setConnectionId(event.target.value);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={editor.busy === 'save'}
          onClick={() => void editor.attempt('sources', connectionId ? { connectionId } : {})}
        >
          {editor.sourceError && !editor.sources
            ? 'Retry project sources'
            : 'Refresh project sources'}
        </Button>
        {editor.sources?.slack.nextCursor && (
          <Button
            type="button"
            variant="outline"
            disabled={editor.busy === 'sources' || editor.busy === 'save'}
            onClick={() =>
              void editor.attempt('sources', {
                ...(connectionId ? { connectionId } : {}),
                cursor: editor.sources?.slack.nextCursor ?? undefined,
              })
            }
          >
            {editor.sourceError ? 'Retry more Slack channels' : 'More Slack channels'}
          </Button>
        )}
      </div>
    </div>
  );
}

function EditorFeedback({ editor, reloadAvailable }: { editor: Editor; reloadAvailable: boolean }) {
  return (
    <>
      {' '}
      {editor.error && (
        <p role="alert" className="text-sm text-destructive break-words">
          {editor.error}
        </p>
      )}
      {editor.stale && (
        <p role="status" className="text-sm">
          The saved definition changed. Your entered fields and original save token are preserved.
          Review or copy your edits before reloading.
        </p>
      )}
      {reloadAvailable && (
        <Button
          type="button"
          variant="outline"
          disabled={editor.busy === 'save'}
          onClick={() => void editor.reload()}
        >
          Discard edits and reload saved configuration
        </Button>
      )}
      {editor.busy && editor.busy !== 'save' && (
        <p role="status" className="inline-flex items-center gap-2 text-sm">
          <Spinner className="size-3" aria-hidden="true" />
          {editor.busy === 'validate'
            ? 'Validating current draft…'
            : editor.busy === 'sources'
              ? 'Loading project sources…'
              : 'Reloading saved configuration…'}
        </p>
      )}
      {editor.preview && <EventDraftPreview preview={editor.preview} />}
      {editor.sources && <EventSourcesPreview sources={editor.sources} />}
    </>
  );
}
