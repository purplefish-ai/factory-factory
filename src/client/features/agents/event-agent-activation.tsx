import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { StatusCallout } from '@/client/components/status-callout';
import { invalidateAutomationActivationQueries } from '@/client/lib/agent-query-cache';
import { runInBackground } from '@/client/lib/background-task';
import { trpcErrorCode } from '@/client/lib/query-client';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { isTriggerRunning } from './event-trigger-status';
import type { EventAgent } from './types';

type Action = 'enable' | 'pause';
interface Failure {
  action: Action;
  conflict: boolean;
  message: string;
  /** The revision the request was sent with; a newer read clears the failure. */
  revision: number;
}

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * Enable and Pause for one saved event automation. Both send the loaded
 * management revision; a newer revision on the server is a conflict the user
 * resolves by reloading. Enable validates on the server, so it can take a few
 * seconds. Which buttons show depends on the triggers, not the definition flag.
 */
export function EventAgentActivation({
  agent,
  archived,
  children,
}: {
  agent: EventAgent;
  archived: boolean;
  /** Other actions shown in the same row, such as Edit. */
  children?: ReactNode;
}) {
  const utils = trpc.useUtils();
  const enable = trpc.automation.enable.useMutation({ meta: { errorToast: false } });
  const pause = trpc.automation.pause.useMutation({ meta: { errorToast: false } });
  const mounted = useMounted();
  const [pending, setPending] = useState<Action | null>(null);
  const pendingRef = useRef(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const shownFailure = failure?.revision === agent.managementRevision ? failure : null;
  const owner = { projectId: agent.projectId, agentId: agent.id };
  const running = agent.configuredTriggers.some(isTriggerRunning);
  const startable = agent.configuredTriggers.some(
    (trigger) => trigger.capability.status === 'SUPPORTED' && !isTriggerRunning(trigger)
  );

  const perform = async (action: Action) => {
    if (pendingRef.current || archived) {
      return;
    }
    const revision = agent.managementRevision;
    pendingRef.current = true;
    setPending(action);
    setFailure(null);
    try {
      const mutation = action === 'enable' ? enable : pause;
      const result = await mutation.mutateAsync({ ...owner, expectedManagementRevision: revision });
      utils.automation.get.setData(owner, (cached) =>
        cached && cached.managementRevision > result.managementRevision ? cached : result
      );
      runInBackground(
        invalidateAutomationActivationQueries(utils, owner.projectId, owner.agentId),
        "Couldn't refresh automations."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Try again.';
      if (mounted.current) {
        setFailure({ action, conflict: trpcErrorCode(error) === 'CONFLICT', message, revision });
      } else {
        toast.error(`Couldn't ${action} automation. ${message}`);
      }
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(!running || startable) && (
          <Button
            size="sm"
            onClick={() => void perform('enable')}
            disabled={archived || pending !== null}
            pending={pending === 'enable'}
            pendingLabel="Enabling…"
          >
            Enable
          </Button>
        )}
        {running && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void perform('pause')}
            disabled={archived || pending !== null}
            pending={pending === 'pause'}
            pendingLabel="Pausing…"
          >
            Pause
          </Button>
        )}
        {children}
      </div>
      <p className="text-xs text-muted-foreground">
        {running
          ? 'Pause stops listening and cancels queued runs. Runs already started continue. Events that arrive while paused never run.'
          : 'Enable checks the sources and execution settings, then starts listening from now. Earlier events never run.'}
      </p>
      {shownFailure?.conflict && (
        <StatusCallout
          tone="warning"
          role="status"
          title="This automation changed since it was loaded."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                runInBackground(
                  utils.automation.get.invalidate(owner),
                  "Couldn't reload the automation."
                )
              }
            >
              Reload automation
            </Button>
          }
        >
          Reload it to see the latest version, then try again.
        </StatusCallout>
      )}
      {shownFailure && !shownFailure.conflict && (
        <StatusCallout
          tone="danger"
          role="alert"
          title={`Couldn't ${shownFailure.action} this automation.`}
        >
          {shownFailure.message}
        </StatusCallout>
      )}
    </div>
  );
}
