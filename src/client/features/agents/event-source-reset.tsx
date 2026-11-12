import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { StatusCallout } from '@/client/components/status-callout';
import { invalidateAllAutomationQueries } from '@/client/lib/agent-query-cache';
import { runInBackground } from '@/client/lib/background-task';
import { trpcErrorCode } from '@/client/lib/query-client';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { describeSourceHealth } from './event-trigger-status';
import type { EventAgent } from './types';

type Trigger = EventAgent['configuredTriggers'][number];
interface ResetTarget {
  connectionId: string;
  sourceName: string;
  health: Trigger['sourceHealth'];
}
interface ResetOutcome {
  sourceName: string;
  pausedTriggerCount: number;
  cancelledRunCount: number;
}

/** GitHub sources behind a recovery fence, one entry per connection. */
export function sourcesNeedingReset(triggers: readonly Trigger[]): ResetTarget[] {
  const targets = new Map<string, ResetTarget>();
  for (const trigger of triggers) {
    const configuration = trigger.configuration;
    if (
      configuration?.type === 'GITHUB_ISSUE' &&
      trigger.sourceHealth?.state === 'RECOVERY_REQUIRED' &&
      !targets.has(configuration.connectionId)
    ) {
      targets.set(configuration.connectionId, {
        connectionId: configuration.connectionId,
        sourceName: trigger.sourceName ?? 'this GitHub repository',
        health: trigger.sourceHealth,
      });
    }
  }
  return [...targets.values()];
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function resetErrorMessage(error: unknown) {
  const code = trpcErrorCode(error);
  if (code === 'NOT_FOUND') {
    return 'This project no longer uses this source. Reload the automation.';
  }
  if (code === 'PRECONDITION_FAILED' && error instanceof Error) {
    return `${error.message} Reload the automation to see the source's current state.`;
  }
  return error instanceof Error ? error.message : "Couldn't reset the source. Try again.";
}

/**
 * Reset source for each GitHub source in `RECOVERY_REQUIRED`. Resetting is an
 * explicit decision to give up on the events GitHub can no longer list: it
 * pauses every automation on that source, in every project, and each needs
 * Enable again. The dialog and the result live here rather than with the
 * source, because a successful reset takes the source out of recovery.
 */
export function EventSourceRecovery({ agent, archived }: { agent: EventAgent; archived: boolean }) {
  const utils = trpc.useUtils();
  const reset = trpc.automation.resetSource.useMutation({ meta: { errorToast: false } });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submitting = useRef(false);
  const [target, setTarget] = useState<ResetTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ResetOutcome | null>(null);
  const sources = sourcesNeedingReset(agent.configuredTriggers);
  const projectId = agent.projectId;

  const resetSource = async () => {
    if (!target || submitting.current || archived) {
      return;
    }
    submitting.current = true;
    setError(null);
    try {
      const result = await reset.mutateAsync({ projectId, connectionId: target.connectionId });
      runInBackground(invalidateAllAutomationQueries(utils), "Couldn't refresh automations.");
      if (mounted.current) {
        setOutcome({ ...result, sourceName: target.sourceName });
        setTarget(null);
      }
    } catch (failure) {
      if (mounted.current) {
        setError(resetErrorMessage(failure));
      } else {
        toast.error(`Couldn't reset the source. ${resetErrorMessage(failure)}`);
      }
    } finally {
      submitting.current = false;
    }
  };

  return (
    <>
      {sources.map((source) => (
        <StatusCallout
          key={source.connectionId}
          tone="warning"
          title={`${source.sourceName} needs a reset`}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={archived}
              onClick={() => {
                setError(null);
                setOutcome(null);
                setTarget(source);
              }}
            >
              Reset source
            </Button>
          }
        >
          {describeSourceHealth(source.health)}. Nothing on this source runs until it is reset and
          each automation is enabled again.
        </StatusCallout>
      ))}
      {outcome && (
        <StatusCallout tone="success" role="status" title="Source reset.">
          {plural(outcome.pausedTriggerCount, 'trigger', 'triggers')} on {outcome.sourceName} paused
          and {plural(outcome.cancelledRunCount, 'queued run', 'queued runs')} cancelled. Enable
          each automation to start listening from now on.
        </StatusCallout>
      )}
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTarget(null);
            setError(null);
          }
        }}
        title="Reset GitHub source?"
        description={`GitHub can no longer list every event on ${target?.sourceName ?? 'this source'} since the last check. Resetting gives up on that gap and starts again from the current issues. Events from the gap will not run.`}
        confirmText="Reset source"
        pendingText="Resetting…"
        variant="destructive"
        isPending={reset.isPending}
        onConfirm={() => void resetSource()}
      >
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Every automation that uses this source is paused, including automations in other
            projects, and their queued runs are cancelled. Runs already started continue.
          </p>
          <p>Each automation needs Enable again before it listens.</p>
          {error && (
            <StatusCallout tone="danger" role="alert">
              {error}
            </StatusCallout>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}
