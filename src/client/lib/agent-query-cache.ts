import type { trpc } from '@/client/lib/trpc';

/** Refresh only the project that owns the completed mutation, including after navigation. */
export function invalidateAgentProjectQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  projectId: string
) {
  return Promise.all([
    utils.periodicTask.list.invalidate({ projectId }),
    utils.periodicTask.navigationSummary.invalidate({ projectId }),
  ]);
}
