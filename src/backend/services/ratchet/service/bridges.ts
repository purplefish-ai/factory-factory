/**
 * Bridge interfaces for ratchet domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The ratchet domain never imports from other domains directly.
 */

import type {
  CIStatus,
  PRState,
  SessionProvider,
  SessionStatus,
  WorkspaceProviderSelection,
} from '@/shared/core';
import type { PRStateInfo } from './ratchet.types';

// --- Session bridge ---

/** Session capabilities needed by ratchet domain */
export interface RatchetSessionSummary {
  id: string;
  workflow: string;
  status: SessionStatus;
  provider: SessionProvider;
  createdAt: Date;
}

export type RatchetFixerSessionAcquisition =
  | { outcome: 'existing'; sessionId: string; status: SessionStatus }
  | { outcome: 'limit_reached' }
  | { outcome: 'created'; sessionId: string };

export interface RatchetSessionBridge {
  findSessionById(sessionId: string): Promise<RatchetSessionSummary | null>;
  findSessionsByWorkspaceId(workspaceId: string): Promise<RatchetSessionSummary[]>;
  acquireFixerSession(input: {
    workspaceId: string;
    workflow: string;
    sessionName: string;
    maxSessions: number;
    provider?: SessionProvider;
    providerProjectPath: string | null;
  }): Promise<RatchetFixerSessionAcquisition>;
  isSessionRunning(sessionId: string): boolean;
  isSessionWorking(sessionId: string): boolean;
  stopSession(sessionId: string): Promise<void>;
  startSession(
    sessionId: string,
    opts: { initialPrompt?: string; startupModePreset?: 'non_interactive' | 'plan' }
  ): Promise<void>;
  restartSession(
    sessionId: string,
    opts: { initialPrompt?: string; startupModePreset?: 'non_interactive' | 'plan' }
  ): Promise<void>;
  sendSessionMessage(sessionId: string, message: string): Promise<void>;
  injectCommittedUserMessage(sessionId: string, message: string): void;
}

export interface RatchetWorkspaceBridge {
  findFixerContext(workspaceId: string): Promise<{
    id: string;
    worktreePath: string | null;
    defaultSessionProvider: WorkspaceProviderSelection;
    ratchetSessionProvider: WorkspaceProviderSelection;
  } | null>;
  recordSessionEnd(
    workspaceId: string,
    sessionId: string,
    outcome: 'COMPLETED' | 'DIED'
  ): Promise<boolean>;
  markDispatchStalled(workspaceId: string, snapshotKey: string): Promise<boolean>;
}

// --- GitHub bridge ---

/** PR full details as needed by ratchet domain */
export interface RatchetPRFullDetails {
  state: string;
  number: number;
  url: string;
  /** Needed to fold the observation into the cache's enriched `PRState`. */
  isDraft: boolean;
  reviewDecision: string | null;
  mergeStateStatus?: string;
  reviews: Array<{
    submittedAt: string | null;
    author: { login: string };
    state?: string;
    body?: string;
    url?: string;
  }>;
  comments: Array<{ updatedAt: string; author: { login: string } }>;
  statusCheckRollup: Array<{
    name?: string;
    workflowName?: string;
    status?: string;
    conclusion?: string | null;
    detailsUrl?: string;
    startedAt?: string;
    completedAt?: string;
  }> | null;
}

/** Review comment as returned by the GitHub bridge */
export interface RatchetReviewComment {
  id: number;
  author: { login: string };
  body: string;
  path: string;
  line: number | null;
  updatedAt: string;
  url: string;
}

/** Input shape for CI status computation */
export interface RatchetStatusCheckInput {
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  startedAt?: string;
  completedAt?: string;
}

/** PR state as returned by fetchAndComputePRState */
export interface RatchetPRStateSnapshot {
  prState: string;
  prNumber: number;
  prReviewState: string | null;
  prCiStatus: CIStatus;
}

/** PR snapshot capabilities needed by ratchet domain services */
export interface RatchetPRSnapshotBridge {
  /**
   * Persist what a ratchet check observed about the PR.
   *
   * Every field here is an input to `deriveRatchetState`, which is why this
   * carries the PR and review state and not just CI: the projection reads the
   * cache, so an observation the check keeps to itself is an observation the rest
   * of the app never sees.
   */
  recordPrObservation(input: {
    workspaceId: string;
    prNumber: number;
    ciStatus: CIStatus;
    prState: PRState;
    reviewState: string | null;
    /** GitHub's `mergeStateStatus == DIRTY`. */
    hasMergeConflict: boolean;
    failedAt?: Date | null;
    observedAt?: Date;
  }): Promise<void>;
  recordCINotification(workspaceId: string, notifiedAt?: Date): Promise<void>;
  recordReviewCheck(workspaceId: string, checkedAt?: Date | null): Promise<void>;
}

/** GitHub capabilities needed by ratchet domain */
export interface RatchetGitHubBridge {
  extractPRInfo(prUrl: string): { owner: string; repo: string; number?: number } | null;
  getPRFullDetails(
    repo: string,
    prNumber: number,
    signal?: AbortSignal
  ): Promise<RatchetPRFullDetails>;
  getReviewComments(
    repo: string,
    prNumber: number,
    since?: Date,
    signal?: AbortSignal
  ): Promise<RatchetReviewComment[]>;
  /** REST ids of review comments that belong to resolved review threads. */
  getResolvedReviewCommentIds(
    repo: string,
    prNumber: number,
    signal?: AbortSignal
  ): Promise<Set<number>>;
  computeCIStatus(statusChecks: RatchetStatusCheckInput[] | null): CIStatus;
  /**
   * Fold a raw observation into the enriched `PRState` the cache stores. Same
   * mapper the PR-sync poller uses, so the two writers cannot disagree about
   * what `DRAFT` or `APPROVED` means.
   */
  computePRState(input: {
    state: string;
    isDraft: boolean;
    reviewDecision: string | null;
  }): PRState;
  getAuthenticatedUsername(signal?: AbortSignal): Promise<string | null>;
  fetchAndComputePRState(prUrl: string): Promise<RatchetPRStateSnapshot | null>;
  /**
   * Run a PR fetch through the shared coordinator, which skips it when the
   * scheduler's PR sync already fetched this workspace recently or is fetching
   * it right now. A dedup optimization: skipping only costs the caller a stale
   * cache read, never correctness.
   *
   * The claim is scoped to `fetch`, so returning normally records the fetch and
   * throwing releases the claim — neither is the caller's to remember.
   */
  coordinatePrFetch(
    workspaceId: string,
    fetch: () => Promise<PRStateInfo>,
    options?: RatchetCoordinateOptions
  ): Promise<RatchetCoordinatedFetch>;
}

/**
 * Narrowed mirror of the github capsule's `CoordinatedFetch`. The ratchet
 * coordinates exactly one kind of fetch, so the bridge names it rather than
 * carrying the capsule's type parameter across the boundary.
 */
export type RatchetCoordinatedFetch =
  | { status: 'fetched'; value: PRStateInfo }
  | { status: 'skipped'; reason: 'recently_fetched' };

export interface RatchetCoordinateOptions {
  /**
   * Ignore the completed-fetch cooldown while still deferring to a fetch that
   * is actively in flight.
   */
  ignoreCooldown?: boolean;
}
