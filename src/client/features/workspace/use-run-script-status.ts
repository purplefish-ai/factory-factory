import { useEffect, useRef } from 'react';
import { useLiveWorkspaceSnapshot } from '@/client/hooks/use-live-workspace-snapshot';
import { useLatestRef } from '@/client/hooks/use-stable-callback';
import { runInBackground } from '@/client/lib/background-task';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import type { RunScriptStatus } from '@/shared/core';

const ACTIVE_STATUSES = new Set<RunScriptStatus | undefined>(['STARTING', 'RUNNING', 'STOPPING']);

/**
 * The `/snapshots` stream pushes every run-script status transition, wherever
 * it started, but not the port, tunnel URL or configured commands. So: poll
 * fast while a dev server is starting, running or stopping (the tunnel URL
 * arrives after RUNNING, and the poll detects a dead process); poll as before
 * while the stream does not carry the workspace; otherwise do not poll, and
 * refetch when the stream reports a transition.
 */
function runScriptStatusPollInterval(
  queried: RunScriptStatus | undefined,
  streamed: RunScriptStatus | undefined
): number | false {
  if (ACTIVE_STATUSES.has(queried) || ACTIVE_STATUSES.has(streamed)) {
    return POLL_INTERVAL_MS.runningProcess;
  }
  return streamed === undefined ? POLL_INTERVAL_MS.localStatus : false;
}

const selectRunScriptStatus = (entry: { runScriptStatus: RunScriptStatus }) =>
  entry.runScriptStatus;

/** Run-script status for the button, port badge and open-app action; they share one query. */
export function useRunScriptStatus(workspaceId: string) {
  const streamed = useLiveWorkspaceSnapshot(workspaceId, selectRunScriptStatus);
  const query = trpc.workspace.getRunScriptStatus.useQuery(
    { workspaceId },
    {
      refetchInterval: (current) =>
        runScriptStatusPollInterval(current.state.data?.status, streamed),
    }
  );

  const { refetch } = query;
  const queriedRef = useLatestRef(query.data?.status);
  const hasData = query.data !== undefined;
  const lastStreamed = useRef<RunScriptStatus | undefined>(undefined);
  useEffect(() => {
    if (streamed === undefined) {
      // Each connection's first value is checked against HTTP again.
      lastStreamed.current = undefined;
      return;
    }
    if (!hasData) {
      // Compare once the first response lands: it may predate the stream.
      return;
    }
    const previous = lastStreamed.current;
    lastStreamed.current = streamed;
    const changed =
      previous === undefined ? streamed !== queriedRef.current : previous !== streamed;
    if (changed) {
      // The button, badge and open-app action share this query; one request serves all.
      runInBackground(refetch({ cancelRefetch: false }));
    }
  }, [streamed, hasData, refetch]);

  return query;
}
