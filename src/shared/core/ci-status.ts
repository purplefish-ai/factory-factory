import { CIStatus, type CIStatus as CIStatusValue } from './enums.js';

export type CiVisualState = 'PASSING' | 'FAILING' | 'RUNNING' | 'UNKNOWN' | 'NONE';

interface CheckLike {
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
}

function getEffectiveState(check: CheckLike): string {
  if (check.status === 'COMPLETED' && check.conclusion) {
    return check.conclusion;
  }
  return check.state ?? check.status ?? 'PENDING';
}

export function deriveCiStatusFromCheckRollup(
  checks: CheckLike[] | null | undefined
): CIStatusValue {
  if (!checks || checks.length === 0) {
    return CIStatus.UNKNOWN;
  }

  const hasFailure = checks.some((check) => {
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

  const hasPending = checks.some((check) => {
    const state = getEffectiveState(check);
    return (
      state === 'PENDING' ||
      state === 'EXPECTED' ||
      state === 'QUEUED' ||
      state === 'IN_PROGRESS' ||
      check.status === 'QUEUED' ||
      check.status === 'IN_PROGRESS'
    );
  });
  if (hasPending) {
    return CIStatus.PENDING;
  }

  const allSuccess = checks.every((check) => {
    const state = getEffectiveState(check);
    return (
      state === 'SUCCESS' || state === 'NEUTRAL' || state === 'CANCELLED' || state === 'SKIPPED'
    );
  });
  if (allSuccess) {
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
