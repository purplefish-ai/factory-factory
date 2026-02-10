// Domain: ratchet
// Public API for the ratchet domain module.
// Consumers should import from '@/backend/domains/ratchet' only.

export type { CIFailureDetails, CIFixResult } from './ci-fixer.service';
// CI fixer
export { ciFixerService } from './ci-fixer.service';

// CI monitor (legacy, deprecated in favor of ratchet service)
export { ciMonitorService } from './ci-monitor.service';
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
  WorkspaceRatchetResult,
} from './ratchet.service';
// Core ratchet polling and dispatch
export { ratchetService } from './ratchet.service';

// Reconciliation (workspace/session cleanup)
export { reconciliationService } from './reconciliation.service';
