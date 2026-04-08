import { CIStatus, type CIStatus as CIStatusValue } from './enums.js';

export type CiVisualState = 'PASSING' | 'FAILING' | 'RUNNING' | 'UNKNOWN' | 'NONE';

interface CheckLike {
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
  name?: string | null;
  workflowName?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

function normalizeCheckValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value.toUpperCase();
}

function getEffectiveState(check: CheckLike): string {
  const normalizedStatus = normalizeCheckValue(check.status);
  const normalizedConclusion = normalizeCheckValue(check.conclusion);
  const normalizedState = normalizeCheckValue(check.state);

  if (normalizedStatus === 'COMPLETED' && normalizedConclusion) {
    return normalizedConclusion;
  }

  return normalizedState ?? normalizedStatus ?? 'PENDING';
}

function parseRunId(detailsUrl: string | null | undefined): number | null {
  if (!detailsUrl) {
    return null;
  }

  const match = detailsUrl.match(/\/actions\/runs\/(\d+)\b/);
  if (!match) {
    return null;
  }

  const runIdRaw = match[1];
  if (!runIdRaw) {
    return null;
  }

  const runId = Number.parseInt(runIdRaw, 10);
  return Number.isFinite(runId) ? runId : null;
}

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function getObservedAtMs(check: CheckLike): number | null {
  const startedAtMs = parseIsoTimestamp(check.startedAt);
  const completedAtMs = parseIsoTimestamp(check.completedAt);

  if (startedAtMs === null) {
    return completedAtMs;
  }
  if (completedAtMs === null) {
    return startedAtMs;
  }
  return Math.max(startedAtMs, completedAtMs);
}

function getRunAttemptIdentity(check: CheckLike): string | null {
  const runId = parseRunId(check.detailsUrl);
  if (runId === null) {
    return null;
  }

  const rawName = check.name?.trim();
  if (!rawName) {
    return null;
  }

  const normalizedName = rawName.toLowerCase();
  const workflowName = check.workflowName?.trim().toLowerCase() ?? '';
  return `${workflowName}|${normalizedName}`;
}

function shouldReplaceRunAttempt(
  candidate: { runId: number; observedAtMs: number | null; sourceIndex: number },
  existing: { runId: number; observedAtMs: number | null; sourceIndex: number }
): boolean {
  if (candidate.runId !== existing.runId) {
    return candidate.runId > existing.runId;
  }

  if (candidate.observedAtMs !== null && existing.observedAtMs !== null) {
    if (candidate.observedAtMs !== existing.observedAtMs) {
      return candidate.observedAtMs > existing.observedAtMs;
    }
  } else if (candidate.observedAtMs !== null) {
    return true;
  } else if (existing.observedAtMs !== null) {
    return false;
  }

  return candidate.sourceIndex > existing.sourceIndex;
}

export function reduceCheckRollupToLatestRunAttempts<T extends CheckLike>(
  checks: T[] | null | undefined
): T[] | null {
  if (!checks) {
    return null;
  }

  const reduced: T[] = [];
  const identityToIndex = new Map<string, number>();
  const metadataByIdentity = new Map<
    string,
    { runId: number; observedAtMs: number | null; sourceIndex: number }
  >();

  checks.forEach((check, sourceIndex) => {
    const identity = getRunAttemptIdentity(check);
    if (!identity) {
      reduced.push(check);
      return;
    }

    const runId = parseRunId(check.detailsUrl);
    if (runId === null) {
      reduced.push(check);
      return;
    }

    const candidateMeta = {
      runId,
      observedAtMs: getObservedAtMs(check),
      sourceIndex,
    };

    const existingIndex = identityToIndex.get(identity);
    if (existingIndex === undefined) {
      identityToIndex.set(identity, reduced.length);
      metadataByIdentity.set(identity, candidateMeta);
      reduced.push(check);
      return;
    }

    const existingMeta = metadataByIdentity.get(identity);
    if (!existingMeta) {
      metadataByIdentity.set(identity, candidateMeta);
      reduced[existingIndex] = check;
      return;
    }

    if (shouldReplaceRunAttempt(candidateMeta, existingMeta)) {
      metadataByIdentity.set(identity, candidateMeta);
      reduced[existingIndex] = check;
    }
  });

  return reduced;
}

export function deriveCiStatusFromCheckRollup(
  checks: CheckLike[] | null | undefined
): CIStatusValue {
  if (!checks || checks.length === 0) {
    return CIStatus.UNKNOWN;
  }

  const checksForClassification = reduceCheckRollupToLatestRunAttempts(checks);
  if (!checksForClassification || checksForClassification.length === 0) {
    return CIStatus.UNKNOWN;
  }

  const hasFailure = checksForClassification.some((check) => {
    const state = getEffectiveState(check);
    return (
      state === 'FAILURE' ||
      state === 'ERROR' ||
      state === 'ACTION_REQUIRED' ||
      state === 'TIMED_OUT'
    );
  });
  if (hasFailure) {
    return CIStatus.FAILURE;
  }

  const hasPending = checksForClassification.some((check) => {
    const state = getEffectiveState(check);
    return (
      state === 'PENDING' || state === 'EXPECTED' || state === 'QUEUED' || state === 'IN_PROGRESS'
    );
  });
  if (hasPending) {
    return CIStatus.PENDING;
  }

  const allTerminalNonFail = checksForClassification.every((check) => {
    const state = getEffectiveState(check);
    return (
      state === 'SUCCESS' || state === 'SKIPPED' || state === 'NEUTRAL' || state === 'CANCELLED'
    );
  });
  const hasPassingSignal = checksForClassification.some((check) => {
    const state = getEffectiveState(check);
    return state === 'SUCCESS' || state === 'SKIPPED';
  });

  if (allTerminalNonFail && hasPassingSignal) {
    return CIStatus.SUCCESS;
  }

  return CIStatus.UNKNOWN;
}

export function deriveCiVisualStateFromPrCiStatus(
  status: CIStatusValue | null | undefined
): CiVisualState {
  if (status === CIStatus.SUCCESS) {
    return 'PASSING';
  }
  if (status === CIStatus.FAILURE) {
    return 'FAILING';
  }
  if (status === CIStatus.PENDING) {
    return 'RUNNING';
  }
  if (status === CIStatus.UNKNOWN) {
    return 'UNKNOWN';
  }
  return 'UNKNOWN';
}

export function deriveCiVisualStateFromChecks(
  checks: CheckLike[] | null | undefined
): CiVisualState {
  if (!checks || checks.length === 0) {
    return 'NONE';
  }
  return deriveCiVisualStateFromPrCiStatus(deriveCiStatusFromCheckRollup(checks));
}

export function getCiVisualLabel(state: CiVisualState): string {
  switch (state) {
    case 'PASSING':
      return 'CI Passing';
    case 'FAILING':
      return 'CI Failing';
    case 'RUNNING':
      return 'CI Running';
    case 'UNKNOWN':
      return 'CI Unknown';
    case 'NONE':
      return 'No checks';
  }
}
