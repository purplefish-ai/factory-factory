// Domain: ratchet
// Public API for the ratchet domain module.
// Consumers should import from '@/backend/domains/ratchet' only.

// Bridge interfaces for orchestration layer wiring
export type {
  RatchetGitHubBridge,
  RatchetPRFullDetails,
  RatchetPRSnapshotBridge,
  RatchetPRStateSnapshot,
  RatchetReviewComment,
  RatchetSessionBridge,
  RatchetStatusCheckInput,
  RatchetWorkspaceBridge,
} from './bridges';
export type {
  AcquireAndDispatchInput,
  AcquireAndDispatchResult,
  RunningIdleSessionAction,
} from './fixer-session.service';
// Shared fixer session acquisition
export { fixerSessionService } from './fixer-session.service';
export type {
  RatchetAction,
  RatchetCheckResult,
  RatchetStateChangedEvent,
  WorkspaceRatchetResult,
} from './ratchet.service';
// Core ratchet polling and dispatch
export { RATCHET_STATE_CHANGED, ratchetService } from './ratchet.service';

// Reconciliation (workspace/session cleanup)
export { reconciliationService } from './reconciliation.service';
