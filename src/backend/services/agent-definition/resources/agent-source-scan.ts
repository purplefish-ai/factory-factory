import { ApplicationError } from '@/backend/lib/application-error';
import type { AgentIssueEventPage } from '@/shared/agent-source';
import type { AgentSourceEntry, AgentSourceScan } from '@/shared/agent-source-state';

export function discontinuity(): never {
  throw new ApplicationError(
    'CONFLICT',
    'GitHub feed continuity could not be verified. Explicit source recovery is required.'
  );
}

export function newScan(head: string, boundary: string | null): AgentSourceScan {
  return {
    id: crypto.randomUUID(),
    fixedHeadEventId: head,
    previousBoundaryEventId: boundary,
    phase: 'CAPTURE',
    nextPage: 1,
    observationCount: 0,
    verifiedCount: 0,
    finalizedCount: 0,
    resumePage: 1,
    resumeIds: [],
    overlapOffset: null,
    verifyResumeCount: 0,
    verifySeekingOverlap: false,
  };
}

/** Persisted one-page overlap; a shifted offset may require several reads to find it. */
export function resumeScan(scan: AgentSourceScan): AgentSourceScan {
  if (scan.phase === 'CAPTURE' && scan.overlapOffset === null && scan.resumeIds.length) {
    return { ...scan, nextPage: scan.resumePage, overlapOffset: 0 };
  }
  if (scan.phase === 'VERIFY') {
    // Searching for the fixed head can itself span a cycle after a large prepend.
    if (scan.verifiedCount === 0 && scan.nextPage > 1) {
      return scan;
    }
    return {
      ...scan,
      nextPage: scan.resumePage,
      verifiedCount: scan.verifyResumeCount,
      verifySeekingOverlap: scan.verifyResumeCount > 0,
    };
  }
  return scan;
}

function consumeOverlap(scan: AgentSourceScan, ids: string[]): number {
  if (scan.overlapOffset === null) {
    return 0;
  }
  let offset = 0;
  for (; offset < ids.length; offset++) {
    const actual = ids[offset];
    const expected = scan.resumeIds[scan.overlapOffset];
    if (scan.overlapOffset === 0 && actual !== expected) {
      continue;
    }
    if (actual !== expected) {
      discontinuity();
    }
    scan.overlapOffset++;
    if (scan.overlapOffset === scan.resumeIds.length) {
      scan.overlapOffset = null;
      return offset + 1;
    }
  }
  return offset;
}

function knownOutOfOrder(previous: number | null, next: number) {
  return previous !== null && next !== previous + 1;
}

function captureEntries(
  scan: AgentSourceScan,
  captured: AgentSourceEntry[],
  remaining: AgentIssueEventPage['events']
) {
  const fresh: AgentIssueEventPage['events'] = [];
  const positions = new Map(captured.map((entry, index) => [entry.providerEventId, index]));
  let lastKnown: number | null = null;
  let complete = false;
  for (const item of remaining) {
    if (item.providerEventId === scan.previousBoundaryEventId) {
      complete = true;
      break;
    }
    const known = positions.get(item.providerEventId);
    if (known !== undefined) {
      if (fresh.length || knownOutOfOrder(lastKnown, known)) {
        discontinuity();
      }
      lastKnown = known;
    } else {
      if (lastKnown !== null && lastKnown !== captured.length - 1) {
        discontinuity();
      }
      fresh.push(item);
    }
  }
  return { fresh, complete };
}

export function capturePage(
  scan: AgentSourceScan,
  captured: AgentSourceEntry[],
  page: AgentIssueEventPage
) {
  const ids = page.events.map((event) => event.providerEventId);
  const start = consumeOverlap(scan, ids);
  const result = captureEntries(scan, captured, page.events.slice(start));
  const fresh = result.fresh;
  let complete = result.complete;
  if (page.nextPage === null) {
    if (scan.overlapOffset !== null || (scan.previousBoundaryEventId !== null && !complete)) {
      discontinuity();
    }
    complete = true;
  }
  if (fresh.length) {
    scan.resumePage = scan.nextPage;
    scan.resumeIds = fresh.map((item) => item.providerEventId);
  }
  if (complete) {
    scan.phase = 'VERIFY';
    scan.nextPage = 1;
    scan.resumePage = 1;
    scan.resumeIds = [];
    scan.verifiedCount = 0;
    scan.verifyResumeCount = 0;
  } else {
    scan.nextPage = page.nextPage ?? discontinuity();
  }
  return fresh;
}

function verifyEntries(scan: AgentSourceScan, expected: string[], page: AgentIssueEventPage) {
  let started = false;
  for (const item of page.events) {
    if (!started && item.providerEventId !== expected[scan.verifiedCount]) {
      // Head insertion and overlap may move the desired anchor to a later page.
      if (invalidSkippedIdentity(expected, item.providerEventId, scan.verifiedCount)) {
        discontinuity();
      }
      continue;
    }
    started = true;
    if (item.providerEventId !== expected[scan.verifiedCount]) {
      discontinuity();
    }
    scan.verifiedCount++;
    if (scan.verifiedCount === expected.length) {
      if (hasUncapturedTail(scan, page, item)) {
        discontinuity();
      }
      scan.phase = 'FINALIZE';
      return true;
    }
  }
  return false;
}

function hasUncapturedTail(
  scan: AgentSourceScan,
  page: AgentIssueEventPage,
  item: AgentIssueEventPage['events'][number]
) {
  return (
    scan.previousBoundaryEventId === null && (page.nextPage !== null || item !== page.events.at(-1))
  );
}

function invalidSkippedIdentity(expected: string[], identity: string, verifiedCount: number) {
  const position = expected.indexOf(identity);
  return position > verifiedCount || (verifiedCount > 0 && position < 0);
}

/** Unknown identities before a resumed overlap may be a shifted head prefix.
 * Re-prove the interval from its fixed head instead of trusting or ignoring them.
 */
function rewindShiftedOverlap(
  scan: AgentSourceScan,
  expected: string[],
  page: AgentIssueEventPage
) {
  if (!scan.verifySeekingOverlap) {
    return false;
  }
  scan.verifySeekingOverlap = false;
  const anchor = page.events.findIndex(
    (item) => item.providerEventId === expected[scan.verifiedCount]
  );
  const prefix = anchor < 0 ? page.events : page.events.slice(0, anchor);
  if (!prefix.some((item) => !expected.includes(item.providerEventId))) {
    return false;
  }
  scan.nextPage = 1;
  scan.resumePage = 1;
  scan.verifiedCount = 0;
  scan.verifyResumeCount = 0;
  return true;
}

/** Second ordered traversal detects observed changes, without claiming an API snapshot. */
export function verifyPage(
  scan: AgentSourceScan,
  entries: AgentSourceEntry[],
  page: AgentIssueEventPage
) {
  const expected = entries.map((item) => item.providerEventId);
  if (scan.previousBoundaryEventId !== null) {
    expected.push(scan.previousBoundaryEventId);
  }
  if (rewindShiftedOverlap(scan, expected, page)) {
    return;
  }
  const before = scan.verifiedCount;
  if (verifyEntries(scan, expected, page)) {
    return;
  }
  if (page.nextPage === null) {
    discontinuity();
  }
  if (scan.verifiedCount > before) {
    scan.resumePage = scan.nextPage;
    scan.verifyResumeCount = before;
  }
  scan.nextPage = page.nextPage;
}
