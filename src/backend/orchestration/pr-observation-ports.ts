import type { PRObservation, PRTarget } from '@/shared/pr-monitoring';

export interface PRAcceptedObservation {
  workspaceId: string;
  prId: string;
  prUrl: string;
  prNumber: number;
  prState: PRObservation['prState'];
  previousPrState: string;
  prCiStatus: PRObservation['ciStatus'];
  prReviewState: PRObservation['reviewState'];
}

/** Producer capabilities only; application composition owns their implementations. */
export interface PRObservationPorts {
  /** Stable identity shared by every observation entry point in one application graph. */
  readonly cacheScope: object;
  findPR(target: PRTarget): Promise<{ revision: number; state: string } | null>;
  getMonitoring(workspaceId: string): Promise<{ eventEpoch: number } | null>;
  fetchObservation(target: PRTarget, signal?: AbortSignal): Promise<PRObservation>;
  acceptObservation(input: {
    target: PRTarget;
    expectedPrRevision: number;
    expectedEventEpoch: number;
    observation: PRObservation;
  }): Promise<{ applied: boolean }>;
  publishAcceptedObservation(event: PRAcceptedObservation): void;
}
