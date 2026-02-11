/**
 * Bridge interfaces for ratchet domain cross-domain dependencies.
 * These are injected by the orchestration layer at startup.
 * The ratchet domain never imports from other domains directly.
 */

import type { CIStatus } from '@prisma-gen/client';

// --- Session bridge ---

/** Session capabilities needed by ratchet domain */
export interface RatchetSessionBridge {
  isSessionRunning(sessionId: string): boolean;
  isSessionWorking(sessionId: string): boolean;
  stopClaudeSession(sessionId: string): Promise<void>;
  startClaudeSession(sessionId: string, opts: { initialPrompt?: string }): Promise<void>;
  getClient(
    sessionId: string
  ): { isRunning(): boolean; sendMessage(msg: string): Promise<void> } | null;
  injectCommittedUserMessage(sessionId: string, message: string): void;
}

// --- GitHub bridge ---

/** PR full details as needed by ratchet domain */
export interface RatchetPRFullDetails {
  state: string;
  number: number;
  reviewDecision: string | null;
  reviews: Array<{ submittedAt: string; author: { login: string } }>;
  comments: Array<{ updatedAt: string; author: { login: string } }>;
  statusCheckRollup: Array<{
    name?: string;
    status?: string;
    conclusion?: string | null;
    detailsUrl?: string;
  }> | null;
}

/** Review comment as returned by the GitHub bridge */
export interface RatchetReviewComment {
  updatedAt: string;
  author: { login: string };
}

/** Input shape for CI status computation */
export interface RatchetStatusCheckInput {
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
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
}

// --- Workspace bridge ---

/** Workspace capabilities needed by ratchet domain */
export interface RatchetWorkspaceBridge {
  markFailed(workspaceId: string, reason: string): Promise<void>;
}

/** GitHub capabilities needed by ratchet domain */
export interface RatchetGitHubBridge {
  extractPRInfo(prUrl: string): { owner: string; repo: string; number?: number } | null;
  getPRFullDetails(repo: string, prNumber: number): Promise<RatchetPRFullDetails>;
  getReviewComments(repo: string, prNumber: number): Promise<RatchetReviewComment[]>;
  computeCIStatus(statusChecks: RatchetStatusCheckInput[] | null): CIStatus;
  getAuthenticatedUsername(): Promise<string | null>;
  fetchAndComputePRState(prUrl: string): Promise<RatchetPRStateSnapshot | null>;
}
