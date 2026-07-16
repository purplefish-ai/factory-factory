/**
 * Bridge interfaces for ratchet domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The ratchet domain never imports from other domains directly.
 */

import type { CIStatus, SessionStatus } from '@/shared/core';

// --- Session bridge ---

/** Session capabilities needed by ratchet domain */
export interface RatchetSessionSummary {
  id: string;
  workflow: string;
  status: SessionStatus;
}

export interface RatchetSessionBridge {
  findSessionsByWorkspaceId(workspaceId: string): Promise<RatchetSessionSummary[]>;
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

// --- GitHub bridge ---

/** PR full details as needed by ratchet domain */
export interface RatchetPRFullDetails {
  state: string;
  number: number;
  url: string;
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
  recordCIObservation(input: {
    workspaceId: string;
    ciStatus: CIStatus;
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
  getAuthenticatedUsername(signal?: AbortSignal): Promise<string | null>;
  fetchAndComputePRState(prUrl: string): Promise<RatchetPRStateSnapshot | null>;
  /** True when another service has an in-flight or recent PR fetch for this workspace. */
  isRecentlyFetched(workspaceId: string): boolean;
  /** True only while another service's PR fetch is actively in flight for this workspace. */
  isFetchInFlight(workspaceId: string): boolean;
  /** Claim this workspace as in-flight before starting an async fetch (dedup optimization). */
  startFetch(workspaceId: string): void;
  /** Record that a PR fetch completed successfully for this workspace (dedup optimization). */
  registerFetch(workspaceId: string): void;
  /** Release an in-flight claim without recording a successful fetch (call on failure). */
  cancelFetch(workspaceId: string): void;
}
