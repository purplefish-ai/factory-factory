// Domain: ratchet
// Public API for the ratchet domain module.
// Consumers should import from '@/backend/services/ratchet' only.

export type {
  RatchetAction,
  RatchetCheckResult,
  RatchetDispatchChangedEvent,
  RatchetStateChangedEvent,
  RatchetToggledEvent,
  WorkspaceRatchetResult,
} from './ratchet.service';
// Core ratchet polling and dispatch
export {
  RATCHET_DISPATCH_CHANGED,
  RATCHET_STATE_CHANGED,
  RATCHET_TOGGLED,
  ratchetService,
} from './ratchet.service';
