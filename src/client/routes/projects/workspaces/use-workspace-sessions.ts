import { useEffect, useRef } from 'react';
import { useLiveWorkspaceSnapshot } from '@/client/hooks/use-live-workspace-snapshot';
import { useLatestRef } from '@/client/hooks/use-stable-callback';
import { runInBackground } from '@/client/lib/background-task';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';

interface ListedSession {
  id: string;
  name: string | null;
  workflow: string | null;
  model: string | null;
  status: string;
}

/** The session list fields the tabs show, so runtime-only changes do not refetch. */
function sessionListSignature(sessions: readonly ListedSession[]): string {
  return JSON.stringify(
    sessions.map((session) => [
      session.id,
      session.name,
      session.workflow,
      session.model,
      session.status,
    ])
  );
}

const selectSessionListSignature = (entry: WorkspaceSnapshotEntry) =>
  sessionListSignature(
    entry.sessionSummaries.map((summary) => ({
      id: summary.sessionId,
      name: summary.name,
      workflow: summary.workflow,
      model: summary.model,
      status: summary.persistedStatus,
    }))
  );

/**
 * The workspace's sessions for the tab bar. The `/snapshots` stream carries
 * each session's runtime state and re-sends the session list whenever a
 * session's runtime changes, so a session started, stopped or closed anywhere
 * reaches this list through a refetch the stream triggers. A rename, or a
 * session created without starting, re-sends nothing until the next runtime
 * change or the periodic repair, so a slow poll stays for those while the
 * stream is live. Without the stream the list polls as it always did.
 */
export function useWorkspaceSessions(workspaceId: string) {
  const streamed = useLiveWorkspaceSnapshot(workspaceId, selectSessionListSignature);
  const query = trpc.session.listSessions.useQuery(
    { workspaceId },
    {
      refetchInterval:
        streamed === undefined ? POLL_INTERVAL_MS.activity : POLL_INTERVAL_MS.background,
      staleTime: 0, // Always refetch on invalidate - critical for session creation UX
    }
  );

  const { refetch } = query;
  const queriedRef = useLatestRef(query.data);
  const lastStreamed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (streamed === undefined) {
      return;
    }
    const previous = lastStreamed.current;
    lastStreamed.current = streamed;
    // A first stream value only matters if HTTP disagrees; later ones are changes.
    const queried = queriedRef.current;
    const changed =
      previous === undefined
        ? queried !== undefined && sessionListSignature(queried) !== streamed
        : previous !== streamed;
    if (changed) {
      runInBackground(refetch());
    }
  }, [streamed, refetch]);

  return query;
}
