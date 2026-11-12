import type { QueryClient } from '@tanstack/react-query';
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
    // Saving can pause triggers and cancel queued runs, as Enable and Pause can.
    invalidateAutomationActivationQueries(utils, projectId, agentId),
    utils.automation.getProposal.invalidate(undefined, {
      predicate: (query) => {
        // A first read still in flight may have started before the delete and
        // would land the old proposal; restart it so it reads the current state.
        if (query.state.data === undefined) {
          return query.state.fetchStatus === 'fetching';
        }
        const proposal = agentProposalSchema.safeParse(query.state.data);
        return proposal.success && proposal.data.agentDefinitionId === agentId;
      },
    }),
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
 * After Resolve, Abandon or Retry on a run: the same reads as Enable and Pause.
 * The run's status, its workspace origin and the rail's counts can all change.
 */
export function invalidateRunRecoveryQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  projectId: string,
  agentId: string
) {
  return invalidateAutomationActivationQueries(utils, projectId, agentId);
}

/**
 * After a delete. The project's list and rail entry refresh, and so do
 * workspace origins, whose run is now gone. The deleted automation's own reads
 * and history are marked stale without refetching: the detail closes, and a
 * refetch would only report the automation missing. A chat proposal card for
 * it is reset, because deleting the automation also deletes its proposal, and
 * so is any proposal card whose first read is still in flight.
 */
export function invalidateDeletedAutomationQueries(
  utils: ReturnType<typeof trpc.useUtils>,
  queryClient: QueryClient,
  projectId: string,
  agentId: string
) {
  const owner = { projectId, agentId };
  return Promise.all([
    utils.automation.list.invalidate({ projectId }),
    utils.automation.navigationSummary.invalidate({ projectId }),
    utils.automation.get.invalidate(owner, { refetchType: 'none' }),
    utils.automation.runs.invalidate(owner, { refetchType: 'none' }),
    utils.automation.evaluations.invalidate(owner, { refetchType: 'none' }),
    utils.automation.workspaceOrigin.invalidate({ projectId }),
    resetDeletedProposalCards(queryClient, agentId),
  ]);
}

/**
 * Proposal cards for a deleted automation, and any card whose first read is
 * still in flight: that read may have started before the delete and would land
 * the old proposal. A first read is shared rather than cancelled by a refetch,
 * so it is cancelled explicitly before the reset reads again.
 */
async function resetDeletedProposalCards(queryClient: QueryClient, agentId: string) {
  const queryKey = getQueryKey(trpc.automation.getProposal);
  const firstReads = queryClient
    .getQueryCache()
    .findAll({ queryKey })
    .filter((query) => query.state.data === undefined && query.state.fetchStatus === 'fetching');
  await Promise.all(firstReads.map((query) => query.cancel({ revert: true })));
  await queryClient.resetQueries({
    queryKey,
    predicate: (query) => {
      if (firstReads.includes(query)) {
        return true;
      }
      const proposal = agentProposalSchema.safeParse(query.state.data);
      return proposal.success && proposal.data.agentDefinitionId === agentId;
    },
  });
}

/**
 * After a source reset: every cached event automation, in every project. The
 * reset pauses each trigger on the source across projects and cancels its
 * queued runs, and the client cannot tell which other projects use it.
 */
export function invalidateAllAutomationQueries(utils: ReturnType<typeof trpc.useUtils>) {
  return Promise.all([
    utils.automation.list.invalidate(),
    utils.automation.navigationSummary.invalidate(),
    utils.automation.get.invalidate(),
    utils.automation.runs.invalidate(),
    utils.automation.evaluations.invalidate(),
    utils.automation.workspaceOrigin.invalidate(),
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
const eventHistoryPageOptions = {
  getNextPageParam: (page: { nextCursor: string | null }) => page.nextCursor ?? undefined,
  refetchInterval: POLL_INTERVAL_MS.activity,
};

/**
 * Keyset pages, newest first, under tRPC's infinite key, so owner invalidation
 * above reaches them. The server strips the `direction` field tRPC adds. A
 * refetch rereads every loaded page from the first cursor, so new runs never
 * leave a gap between pages.
 */
export function useEventRunPages({ projectId, agentId }: EventHistoryOwner) {
  return trpc.automation.runs.useInfiniteQuery({ projectId, agentId }, eventHistoryPageOptions);
}

/** The Events view: how one event automation's triggers decided each event. */
export function useEventEvaluationPages({ projectId, agentId }: EventHistoryOwner) {
  return trpc.automation.evaluations.useInfiniteQuery(
    { projectId, agentId },
    eventHistoryPageOptions
  );
}
