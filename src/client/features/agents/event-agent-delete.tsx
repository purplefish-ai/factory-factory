import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { StatusCallout } from '@/client/components/status-callout';
import { invalidateDeletedAutomationQueries } from '@/client/lib/agent-query-cache';
import { runInBackground } from '@/client/lib/background-task';
import { trpcErrorCode } from '@/client/lib/query-client';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { EventAgent } from './types';

interface Failure {
  conflict: boolean;
  message: string;
  /** The revision the request was sent with; a conflict clears once a newer read arrives. */
  revision: number;
}

/**
 * Delete for one saved event automation, confirmed through a dialog. The
 * server pauses the automation and cancels its queued runs, and refuses while
 * a started run is unfinished; that refusal stays in the dialog with the
 * server's reason. A stale revision offers a reload.
 */
export function EventAgentDelete({
  agent,
  archived,
  onDeleted,
}: {
  agent: EventAgent;
  archived: boolean;
  /** Closes the detail and returns to the list. */
  onDeleted: (agentId: string) => void;
}) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const remove = trpc.automation.delete.useMutation({ meta: { errorToast: false } });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submitting = useRef(false);
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const shownFailure =
    failure?.conflict && failure.revision !== agent.managementRevision ? null : failure;
  const owner = { projectId: agent.projectId, agentId: agent.id };

  const deleteAgent = async () => {
    if (submitting.current || archived) {
      return;
    }
    const revision = agent.managementRevision;
    submitting.current = true;
    setFailure(null);
    try {
      await remove.mutateAsync({ ...owner, expectedManagementRevision: revision });
      if (mounted.current) {
        setOpen(false);
      }
      onDeleted(owner.agentId);
      runInBackground(
        invalidateDeletedAutomationQueries(utils, queryClient, owner.projectId, owner.agentId),
        "Couldn't refresh automations."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Try again.';
      if (mounted.current) {
        setFailure({ conflict: trpcErrorCode(error) === 'CONFLICT', message, revision });
      } else {
        toast.error(`Couldn't delete automation. ${message}`);
      }
    } finally {
      submitting.current = false;
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        disabled={archived}
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
      >
        Delete
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setFailure(null);
          }
        }}
        title={`Delete ${agent.name}?`}
        description="This permanently deletes the automation with its triggers, its run and event history, and the saved proposal in the chat that created it. This cannot be undone."
        confirmText="Delete automation"
        pendingText="Deleting…"
        variant="destructive"
        isPending={remove.isPending}
        onConfirm={() => void deleteAgent()}
      >
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>Workspaces its runs started are kept, with their chats and pull requests.</p>
          <p>
            Queued runs are cancelled. While a started run is unfinished, the automation can't be
            deleted: let the run finish, or stop it first.
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
              Reload it to see the latest version, then delete again.
            </StatusCallout>
          )}
          {shownFailure && !shownFailure.conflict && (
            <StatusCallout tone="danger" role="alert" title="Couldn't delete this automation.">
              {shownFailure.message}
            </StatusCallout>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}
