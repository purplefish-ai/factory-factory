import { z } from 'zod';
import {
  agentSourcePageEvidenceSchema,
  agentSourcePageNumberSchema,
} from '@/shared/agent-source-state';
import type { AgentSourceCheckpoint, AgentSourcePage, Prisma } from '@prisma-gen/client';
import { invalidSkippedIdentity, hasUnknownVerificationPrefix } from './agent-source-verification';

type Tx = Prisma.TransactionClient;
const verificationSchema = z.strictObject({
  version: z.literal(1),
  nextPage: agentSourcePageNumberSchema,
  resumePage: agentSourcePageNumberSchema,
  resumeCount: z.number().int().nonnegative().max(2_147_483_647),
  seekingOverlap: z.boolean(),
});
type Verification = z.infer<typeof verificationSchema>;
type Progress = Verification & { count: number };
const initial: Verification = {
  version: 1,
  nextPage: 1,
  resumePage: 1,
  resumeCount: 0,
  seekingOverlap: false,
};

function resumeProgress(checkpoint: AgentSourceCheckpoint, page: AgentSourcePage, total: number) {
  const parsed = verificationSchema.safeParse(checkpoint.verification ?? initial);
  if (!parsed.success || checkpoint.verifiedCount < 0 || checkpoint.verifiedCount >= total) {
    return null;
  }
  const state: Progress = { ...parsed.data, count: checkpoint.verifiedCount };
  if (page.requestPage !== state.nextPage && !(state.count === 0 && state.nextPage > 1)) {
    state.nextPage = state.resumePage;
    state.count = state.resumeCount;
    state.seekingOverlap = state.resumeCount > 0;
  }
  return page.requestPage === state.nextPage ? state : null;
}

/** Match resumeScan/rewindShiftedOverlap: an observation discarded by the scanner is not proof. */
function rewindOverlap(state: Progress, ids: string[], positions: Map<string, number>) {
  if (!state.seekingOverlap) {
    return false;
  }
  state.seekingOverlap = false;
  const anchor = ids.findIndex((id) => positions.get(id) === state.count);
  if (!hasUnknownVerificationPrefix(ids, anchor, (id) => positions.has(id))) {
    return false;
  }
  Object.assign(state, { nextPage: 1, resumePage: 1, resumeCount: 0, count: 0 });
  return true;
}

function consume(
  state: Progress,
  ids: string[],
  positions: Map<string, number>,
  total: number,
  page: AgentSourcePage,
  emptyBoundary: boolean
) {
  let started = false;
  for (const id of ids) {
    const position = positions.get(id);
    if (!started && position !== state.count) {
      if (invalidSkippedIdentity(position, state.count)) {
        return false;
      }
      continue;
    }
    started = true;
    if (position !== state.count) {
      return false;
    }
    state.count++;
    if (state.count === total) {
      return !(emptyBoundary && (page.nextPage !== null || id !== ids.at(-1)));
    }
  }
  return true;
}

function progressData(state: Progress) {
  const { count, ...verification } = state;
  return { verifiedCount: count, verification };
}

/** Replay canonical verification using only this page's indexed identities (at most100). */
export async function verifyCheckpointPage(
  tx: Tx,
  checkpoint: AgentSourceCheckpoint,
  page: AgentSourcePage
) {
  const evidence = agentSourcePageEvidenceSchema.parse(page.evidence);
  if (evidence.entries.length || !checkpoint.boundaryKnown) {
    return null;
  }
  const total = checkpoint.entryCount + (checkpoint.previousBoundaryEventId ? 1 : 0);
  const state = resumeProgress(checkpoint, page, total);
  if (!state) {
    return null;
  }
  const heads = await tx.agentSourceHead.findMany({
    where: {
      connectionId: page.connectionId,
      scanId: page.scanId,
      providerEventId: { in: evidence.ids },
    },
  });
  const positions = new Map(heads.map((head) => [head.providerEventId, head.position]));
  if (checkpoint.previousBoundaryEventId) {
    positions.set(checkpoint.previousBoundaryEventId, checkpoint.entryCount);
  }
  if (rewindOverlap(state, evidence.ids, positions)) {
    return progressData(state);
  }
  const before = state.count;
  if (
    !consume(
      state,
      evidence.ids,
      positions,
      total,
      page,
      checkpoint.previousBoundaryEventId === null
    )
  ) {
    return null;
  }
  if (state.count < total) {
    if (page.nextPage === null) {
      return null;
    }
    if (state.count > before) {
      state.resumePage = page.requestPage;
      state.resumeCount = before;
    }
    state.nextPage = page.nextPage;
  } else {
    state.nextPage = page.requestPage;
  }
  return progressData(state);
}
