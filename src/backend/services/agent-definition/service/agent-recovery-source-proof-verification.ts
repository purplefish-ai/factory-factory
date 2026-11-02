import {
  hasUnknownVerificationPrefix,
  invalidSkippedIdentity,
} from '@/backend/services/agent-definition/resources/agent-source-verification';
import { agentSourcePageEvidenceSchema } from '@/shared/agent-source-state';
import type { DurableRecovery } from '@/shared/schemas/durable-recovery.schema';

type Checkpoint = DurableRecovery['agentSourceCheckpoint'][number];
type Page = DurableRecovery['agentSourcePage'][number];
type Head = DurableRecovery['agentSourceHead'][number];
type Progress = {
  count: number;
  nextPage: number;
  resumePage: number;
  resumeCount: number;
  seekingOverlap: boolean;
};
type Observation = { page: Page; ids: string[] };
type Unproved = {
  minimum: number;
  maximum: number;
  nextPage: number;
  resumePage: number | null;
  seekingOverlap: boolean;
  maximumResumeCount: number;
  maximumResumePage: number;
  strictSavedCount: boolean;
};

function validCompletion(emptyBoundary: boolean, page: Page, id: string, ids: string[]) {
  return !(emptyBoundary && (page.nextPage !== null || id !== ids.at(-1)));
}

function rewindOverlap(state: Progress, ids: string[], positions: Map<string, number>) {
  if (!state.seekingOverlap) {
    return false;
  }
  state.seekingOverlap = false;
  const anchor = ids.findIndex((id) => positions.get(id) === state.count);
  if (!hasUnknownVerificationPrefix(ids, anchor, (id) => positions.has(id))) {
    return false;
  }
  Object.assign(state, { count: 0, nextPage: 1, resumePage: 1, resumeCount: 0 });
  return true;
}

function consume(
  state: Progress,
  observation: Observation,
  positions: Map<string, number>,
  total: number,
  emptyBoundary: boolean
) {
  const { page, ids } = observation;
  if (rewindOverlap(state, ids, positions)) {
    return true;
  }
  const before = state.count;
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
      state.nextPage = page.requestPage;
      return validCompletion(emptyBoundary, page, id, ids);
    }
  }
  if (page.nextPage === null) {
    return false;
  }
  if (state.count > before) {
    state.resumeCount = before;
    state.resumePage = page.requestPage;
  }
  state.nextPage = page.nextPage;
  return true;
}

function resumeState(state: Progress, requestPage: number) {
  if (requestPage === state.nextPage) {
    return state;
  }
  if (state.count === 0 && state.nextPage > 1) {
    return null;
  }
  if (requestPage !== state.resumePage) {
    return null;
  }
  return {
    ...state,
    count: state.resumeCount,
    nextPage: state.resumePage,
    seekingOverlap: state.resumeCount > 0,
  };
}

function progress(count: number, page: number, seekingOverlap = false): Progress {
  return { count, nextPage: page, resumePage: page, resumeCount: count, seekingOverlap };
}

function resumeUnproved(state: Unproved, requestPage: number, concrete: Progress[]) {
  if (requestPage === state.nextPage) {
    return state;
  }
  if (state.resumePage === null) {
    // Only the last advancing page sets saved progress; its parsed evidence
    // contains at most100 identities. An erased overlap cannot rewind farther.
    if (requestPage > state.maximumResumePage) {
      return null;
    }
    const minimum = Math.max(0, state.minimum - 100);
    const maximum = Math.min(
      state.maximum - (state.strictSavedCount ? 1 : 0),
      state.maximumResumeCount,
      (requestPage - 1) * 100
    );
    if (maximum < minimum) {
      return null;
    }
    if (minimum === 0) {
      concrete.push(progress(0, requestPage));
    }
    return maximum > 0
      ? {
          ...state,
          minimum: Math.max(1, minimum),
          maximum,
          nextPage: requestPage,
          resumePage: requestPage,
          seekingOverlap: true,
        }
      : null;
  }
  return requestPage === state.resumePage
    ? { ...state, nextPage: requestPage, seekingOverlap: true }
    : null;
}

function unprovedCandidates(state: Unproved, ids: string[], positions: Map<string, number>) {
  const observed = ids.map((id) => positions.get(id));
  const anchors = new Set(
    observed.filter(
      (position): position is number =>
        position !== undefined && position >= state.minimum && position <= state.maximum
    )
  );
  const concrete = [...anchors].map((count) =>
    progress(count, state.nextPage, state.seekingOverlap)
  );
  const unknownIdentity = observed.some((position) => position === undefined);
  // An unobserved offset cannot advance. If its resumed overlap has an unknown
  // prefix, all such offsets have the same discarded-observation continuation.
  const discarded =
    state.seekingOverlap &&
    unknownIdentity &&
    [...anchors].filter((count) => count > 0).length <
      state.maximum - Math.max(1, state.minimum) + 1;
  return {
    concrete,
    discarded,
    unknownIdentity,
    maximumObserved: Math.max(-1, ...observed.filter((position) => position !== undefined)),
  };
}

function advanceUnproved(
  state: Unproved | null,
  observation: Observation,
  positions: Map<string, number>,
  total: number,
  emptyBoundary: boolean
) {
  const concrete: Progress[] = [];
  const resumed = state && resumeUnproved(state, observation.page.requestPage, concrete);
  if (!resumed) {
    return {
      state: null,
      concrete: concrete.filter((candidate) =>
        consume(candidate, observation, positions, total, emptyBoundary)
      ),
    };
  }
  const candidates = unprovedCandidates(resumed, observation.ids, positions);
  concrete.push(...candidates.concrete);
  const advanced = concrete.filter((candidate) =>
    consume(candidate, observation, positions, total, emptyBoundary)
  );
  if (candidates.discarded) {
    advanced.push(progress(0, 1));
  }
  const minimum = Math.max(resumed.minimum, candidates.maximumObserved + 1);
  const nextPage = observation.page.nextPage;
  const remaining = unprovedRemainder(resumed, candidates.unknownIdentity, minimum, nextPage);
  return { state: remaining, concrete: advanced };
}

function unprovedRemainder(
  state: Unproved,
  unknownIdentity: boolean,
  minimum: number,
  nextPage: number | null
) {
  if (nextPage === null) {
    return null;
  }
  if (unknownIdentity) {
    return null;
  }
  return minimum <= state.maximum ? { ...state, minimum, nextPage, seekingOverlap: false } : null;
}

/** GitHub advances pageq to q+1: before requestq, count<=100*(q-1).
 * N erased observations can save only a page<=N, with before-count<=100*(N-1).
 * Normal progress has savedpage<firstPage; equal saved/current count requires
 * an extra resumed observation beyond the firstPage-1 forward observations.
 * Already-resumed progress instead has savedpage=firstPage and count=saved.
 * Keep those two reachable intervals separate until retained evidence advances.
 */
function erasedProgress(firstPage: number, total: number, missing: number, maximum: number) {
  const maximumResumeCount = Math.min(total - 2, (missing - 1) * 100);
  const normal: Unproved = {
    minimum: 1,
    maximum,
    nextPage: firstPage,
    resumePage: null,
    seekingOverlap: false,
    maximumResumeCount,
    maximumResumePage: Math.min(missing, firstPage - 1),
    strictSavedCount: missing < firstPage,
  };
  const states = maximum > 0 ? [normal] : [];
  const resumedMaximum = Math.min(maximum, maximumResumeCount);
  if (firstPage <= missing && resumedMaximum > 0) {
    states.push({
      ...normal,
      maximum: resumedMaximum,
      resumePage: firstPage,
      seekingOverlap: true,
    });
  }
  return states;
}

function replay(
  observations: Observation[],
  positions: Map<string, number>,
  total: number,
  partial: boolean,
  maximumInitialCount: number,
  missingVerificationPages: number,
  emptyBoundary: boolean
) {
  const firstPage = observations[0]?.page.requestPage ?? 1;
  let states = [{ ...progress(0, 1), nextPage: partial ? firstPage : 1 }];
  let unproved = partial
    ? erasedProgress(firstPage, total, missingVerificationPages, maximumInitialCount)
    : [];
  for (const observation of observations) {
    const advanced = unproved.map((state) =>
      advanceUnproved(state, observation, positions, total, emptyBoundary)
    );
    unproved = advanced.flatMap((result) => (result.state ? [result.state] : []));
    const next = new Map(
      advanced.flatMap((result) => result.concrete).map((state) => [JSON.stringify(state), state])
    );
    for (const state of states) {
      const resumed = state.count < total && resumeState(state, observation.page.requestPage);
      if (resumed && consume(resumed, observation, positions, total, emptyBoundary)) {
        next.set(JSON.stringify(resumed), resumed);
      }
    }
    states = [...next.values()];
  }
  return states.some((state) => state.count === total);
}

/** Retained VERIFY observations must admit the same canonical replay as the
 * runtime/indexer. Compaction can erase a prefix, including its saved overlap;
 * permanent head positions constrain that uncertainty, never imported cursors.
 */
export function validRecoveryVerification(checkpoint: Checkpoint, pages: Page[], heads: Head[]) {
  const retained = pages.slice().sort((a, b) => a.ordinal - b.ordinal);
  const observations: Observation[] = [];
  for (const page of retained) {
    if (page.phase !== 'VERIFY') {
      continue;
    }
    const evidence = agentSourcePageEvidenceSchema.safeParse(page.evidence);
    if (
      !evidence.success ||
      evidence.data.entries.length ||
      new Set(evidence.data.ids).size !== evidence.data.ids.length ||
      (page.nextPage !== null && page.nextPage !== page.requestPage + 1)
    ) {
      return false;
    }
    observations.push({ page, ids: evidence.data.ids });
  }
  const first = observations[0]?.page;
  const last = observations.at(-1)?.page;
  if (!(first && last)) {
    return true;
  }
  const marker = retained.find((page) => page.phase === 'FINALIZED');
  if (
    observations.some(({ page }, index) => page.ordinal !== first.ordinal + index) ||
    retained.some((page) => page.phase === 'CAPTURE' && page.ordinal > first.ordinal) ||
    !marker ||
    marker.ordinal !== last.ordinal + 1 ||
    marker.requestPage !== last.requestPage ||
    checkpoint.nextOrdinal !== marker.ordinal + 1
  ) {
    return false;
  }
  const positions = new Map(heads.map((head) => [head.providerEventId, head.position]));
  if (checkpoint.previousBoundaryEventId !== null) {
    positions.set(checkpoint.previousBoundaryEventId, checkpoint.entryCount);
  }
  // At most100 new heads fit in a capture observation. An erased prefix must
  // contain at least this many capture pages before any verification progress.
  const missingVerificationPages = first.ordinal - Math.ceil(checkpoint.verifiedCount / 100);
  if (missingVerificationPages < 0 || first.requestPage > missingVerificationPages + 1) {
    return false;
  }
  const partial =
    !retained.some((page) => page.phase === 'CAPTURE') && missingVerificationPages > 0;
  return replay(
    observations,
    positions,
    checkpoint.verifiedCount,
    partial,
    Math.min(
      checkpoint.verifiedCount - 1,
      missingVerificationPages * 100,
      (first.requestPage - 1) * 100
    ),
    missingVerificationPages,
    checkpoint.previousBoundaryEventId === null
  );
}
