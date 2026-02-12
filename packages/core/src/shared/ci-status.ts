import type { CIStatus } from '../types/enums.js';

export type CiVisualState = 'PASSING' | 'FAILING' | 'RUNNING' | 'UNKNOWN' | 'NONE';

interface CheckLike {
  conclusion: string | null;
  status: string;
}

export function deriveCiVisualStateFromPrCiStatus(
  status: CIStatus | null | undefined
): CiVisualState {
  if (status === 'SUCCESS') {
    return 'PASSING';
  }
  if (status === 'FAILURE') {
    return 'FAILING';
  }
  if (status === 'PENDING') {
    return 'RUNNING';
  }
  if (status === 'UNKNOWN') {
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

  const hasFailure = checks.some((check) => check.conclusion === 'FAILURE');
  if (hasFailure) {
    return 'FAILING';
  }

  const hasPending = checks.some(
    (check) => check.status !== 'COMPLETED' || check.conclusion === null
  );
  if (hasPending) {
    return 'RUNNING';
  }

  return 'PASSING';
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
