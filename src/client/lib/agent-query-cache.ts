import { type QueryKey, useInfiniteQuery } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { agentProposalSchema } from '@/shared/agent-proposal';

/** Refresh only the project that owns the completed mutation, including after navigation. */
export function invalidateAgentProjectQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  projectId: string
) {
  return Promise.all([
    utils.periodicTask.list.invalidate({ projectId }),
    utils.periodicTask.navigationSummary.invalidate({ projectId }),
    utils.automation.list.invalidate({ projectId }),
    utils.automation.navigationSummary.invalidate({ projectId }),
  ]);
}
/** Partial input deliberately covers all retainedCursor variants for this saved owner. */
export function invalidateSavedAgentQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  projectId: string,
  agentId: string
) {
  return Promise.all([
    utils.automation.list.invalidate({ projectId }),
    utils.automation.navigationSummary.invalidate({ projectId }),
    utils.automation.get.invalidate({ projectId, agentId }),
    utils.automation.getProposal.invalidate(undefined, {
      predicate: (query) => {
        const proposal = agentProposalSchema.safeParse(query.state.data);
        return proposal.success && proposal.data.agentDefinitionId === agentId;
      },
    }),
    // Saving can pause triggers and cancel queued runs.
    invalidateEventHistoryQueries(utils, projectId, agentId),
  ]);
}

/** After Enable or Pause: the automation, its rail entry and its history (Pause cancels queued runs). */
export function invalidateAutomationActivationQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  projectId: string,
  agentId: string
) {
  return Promise.all([
    utils.automation.list.invalidate({ projectId }),
    utils.automation.navigationSummary.invalidate({ projectId }),
    utils.automation.get.invalidate({ projectId, agentId }),
    invalidateEventHistoryQueries(utils, projectId, agentId),
  ]);
}

/**
 * After a source reset: every event automation in the project, because the
 * reset pauses each trigger on the source and cancels its queued runs.
 */
export function invalidateProjectAutomationQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  projectId: string
) {
  return Promise.all([
    utils.automation.list.invalidate({ projectId }),
    utils.automation.navigationSummary.invalidate({ projectId }),
    utils.automation.get.invalidate({ projectId }),
    utils.automation.runs.invalidate({ projectId }),
    utils.automation.evaluations.invalidate({ projectId }),
    utils.automation.workspaceOrigin.invalidate({ projectId }),
  ]);
}

/** Every loaded Runs and Events page of one event automation, and the workspace origins of its runs. */
export function invalidateEventHistoryQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  projectId: string,
  agentId: string
) {
  return Promise.all([
    utils.automation.runs.invalidate({ projectId, agentId }),
    utils.automation.evaluations.invalidate({ projectId, agentId }),
    utils.automation.workspaceOrigin.invalidate({ projectId }),
  ]);
}

type EventHistoryOwner = { projectId: string; agentId: string };
type EventHistoryPage<T> = { items: T[]; nextCursor: string | null };

/**
 * Keyset pages, newest first. tRPC's own infinite hook adds a `direction`
 * field that the strict history input rejects, so pages are read through the
 * plain client. They keep tRPC's infinite key, so owner invalidation above
 * still reaches them. A refetch rereads every loaded page from the first
 * cursor, so new runs never leave a gap between pages.
 */
function useEventHistoryPages<T>(
  queryKey: QueryKey,
  readPage: (cursor: string | undefined, signal: AbortSignal) => Promise<EventHistoryPage<T>>
) {
  return useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => readPage(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: POLL_INTERVAL_MS.activity,
  });
}

/** The Runs view: one event automation's runs. */
export function useEventRunPages(owner: EventHistoryOwner) {
  const utils = trpc.useUtils();
  const { projectId, agentId } = owner;
  return useEventHistoryPages(
    getQueryKey(trpc.automation.runs, { projectId, agentId }, 'infinite'),
    (cursor, signal) =>
      utils.client.automation.runs.query({ projectId, agentId, cursor }, { signal })
  );
}

/** The Events view: how one event automation's triggers decided each event. */
export function useEventEvaluationPages(owner: EventHistoryOwner) {
  const utils = trpc.useUtils();
  const { projectId, agentId } = owner;
  return useEventHistoryPages(
    getQueryKey(trpc.automation.evaluations, { projectId, agentId }, 'infinite'),
    (cursor, signal) =>
      utils.client.automation.evaluations.query({ projectId, agentId, cursor }, { signal })
  );
}
