import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { resolveAgentSchedule, supportsAgentClockTime } from './agent-schedule';
import { AgentScheduleFields } from './agent-schedule-fields';
import type { AgentCadence, AgentFormValues } from './types';

const REQUIRED_FIELDS_ERROR = 'Name and instructions are required.';

export interface AgentFormProps {
  initialValues?: AgentFormValues;
  onSave: (values: AgentFormValues) => Promise<void>;
  onCancel: () => void;
}

export function AgentForm({ initialValues, onSave, onCancel }: AgentFormProps) {
  const id = useId();
  // Capture the editing baseline once. Polling must not replace drafts or timezone provenance.
  const baseline = useRef(initialValues).current;
  const [name, setName] = useState(baseline?.name ?? '');
  const [prompt, setPrompt] = useState(baseline?.prompt ?? '');
  const [cadence, setCadence] = useState<AgentCadence>(baseline?.cadence ?? 'DAILY');
  const [scheduledTime, setScheduledTime] = useState(baseline?.scheduledTime ?? '');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const clearValidationError = () =>
    setError((current) => (current === REQUIRED_FIELDS_ERROR ? null : current));

  const submit = async () => {
    if (pendingRef.current) {
      return;
    }
    if (!(name.trim() && prompt.trim())) {
      setError(REQUIRED_FIELDS_ERROR);
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        prompt: prompt.trim(),
        cadence,
        ...resolveAgentSchedule({ cadence, scheduledTime }, baseline),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save agent. Please try again.');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          name="name"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            clearValidationError();
          }}
          disabled={pending}
          required
          placeholder="Review recent changes"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-instructions`}>Instructions</Label>
        <Textarea
          id={`${id}-instructions`}
          name="instructions"
          className="min-h-44 resize-y"
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            clearValidationError();
          }}
          disabled={pending}
          required
          placeholder="Describe what this agent should do on each run…"
        />
        <p className="text-xs text-muted-foreground">
          Each run creates a workspace and works toward a pull request.
        </p>
      </div>
      <AgentScheduleFields
        cadence={cadence}
        scheduledTime={scheduledTime}
        onCadenceChange={setCadence}
        onScheduledTimeChange={setScheduledTime}
        disabled={pending}
      />
      <p className="text-xs text-muted-foreground">
        {baseline
          ? 'Changes apply to future runs. A running workspace continues unchanged.'
          : 'This agent runs immediately after creation, then follows its schedule.'}
        {supportsAgentClockTime(cadence) &&
          scheduledTime &&
          ' Clock times use the selected schedule timezone; changing the time uses your browser timezone.'}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : baseline ? 'Save changes' : 'Create Agent'}
        </Button>
      </div>
    </form>
  );
}
