import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Loading } from '@/client/components/loading';
import { QueryState } from '@/client/components/query-state';
import { InlineWorkspaceForm } from '@/client/features/kanban/inline-workspace-form';
import { useWorkspaceCreationDraft } from '@/client/features/kanban/use-workspace-creation-draft';
import { useWorkspaceCreationSubmission } from '@/client/features/kanban/use-workspace-creation-submission';
import { getWorkspaceCreationDraftSnapshot } from '@/client/features/kanban/workspace-creation-draft-storage';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';

/** Route composition keeps workspace creation out of the agents/kanban feature cycle. */
export function EventAgentWorkspaceForm({
  projectId,
  projectSlug,
  onCancel,
}: {
  projectId: string;
  projectSlug: string;
  onCancel: () => void;
}) {
  const navigate = useNavigate();
  const draftId = `event-agent:${projectId}`;
  const submission = useWorkspaceCreationSubmission(draftId);
  const draft = useWorkspaceCreationDraft(draftId);
  const [isCanceling, setIsCanceling] = useState(false);
  const cancelRevision = useRef<string | undefined>(undefined);
  const workspaces = trpc.workspace.listForProject.useQuery({ projectId });
  const cancelFallback = () => {
    if (submission.isPending || draft.isRestoring || isCanceling) {
      return;
    }
    cancelRevision.current ??= draft.hasDraft ? draft.draft.revision : undefined;
    setIsCanceling(true);
    const discard = cancelRevision.current
      ? draft.clearSubmittedDraft(cancelRevision.current)
      : draft.discardDraft();
    runInBackground(
      discard
        .then(() => {
          cancelRevision.current = undefined;
          if (getWorkspaceCreationDraftSnapshot(draftId).draft === null) {
            onCancel();
          }
        })
        .finally(() => setIsCanceling(false)),
      "Couldn't clear canceled event-triggered automation draft."
    );
  };
  if (isCanceling) {
    return <Loading size="compact" message="Canceling event-triggered automation draft…" />;
  }
  return (
    <>
      {submission.isPending && (
        <Loading size="compact" message="Creating event-triggered automation workspace…" />
      )}
      <QueryState
        query={workspaces}
        errorTitle="Couldn't load workspace names"
        loadingMessage="Loading workspace names…"
        size="compact"
      >
        {(data) => (
          <InlineWorkspaceForm
            key={projectId}
            projectId={projectId}
            purpose="event-agent"
            existingNames={data.workspaces.map((workspace) => workspace.name)}
            onCancel={onCancel}
            onCreated={(workspaceId) => {
              void navigate(
                `/projects/${encodeURIComponent(projectSlug)}/workspaces/${encodeURIComponent(workspaceId)}`
              );
            }}
          />
        )}
      </QueryState>
      {!(workspaces.data || submission.isPending) && (
        <Button variant="outline" onClick={cancelFallback} disabled={draft.isRestoring}>
          Cancel
        </Button>
      )}
    </>
  );
}
