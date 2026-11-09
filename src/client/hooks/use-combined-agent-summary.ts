import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';

type Summary = { totalCount: number; failedCount: number };
/** A refresh failure preserves one complete snapshot, never a partial fresh sum. */
export function useCombinedAgentSummary(projectId: string | undefined) {
  const scheduled = trpc.periodicTask.navigationSummary.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId, refetchInterval: 10_000 }
  );
  const event = trpc.automation.navigationSummary.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId, refetchInterval: 10_000 }
  );
  const successful = useRef(new Map<string, Summary>());
  const [combined, setCombined] = useState<{ projectId: string; summary: Summary }>();
  useEffect(() => {
    if (
      !(projectId && scheduled.isSuccess && event.isSuccess) ||
      scheduled.isFetching ||
      event.isFetching
    ) {
      return;
    }
    const summary = {
      totalCount: scheduled.data.totalCount + event.data.totalCount,
      failedCount: scheduled.data.failedCount + event.data.failedCount,
    };
    successful.current.set(projectId, summary);
    setCombined({ projectId, summary });
  }, [
    projectId,
    scheduled.data,
    scheduled.isSuccess,
    scheduled.isFetching,
    event.data,
    event.isSuccess,
    event.isFetching,
  ]);
  if (!projectId) {
    return undefined;
  }
  return combined?.projectId === projectId ? combined.summary : successful.current.get(projectId);
}
