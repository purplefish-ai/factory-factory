import { accessSync, constants, statSync } from 'node:fs';
import { eventRunRecovery } from '@/backend/services/agent-definition';
import {
  eventOwnedWork,
  eventSessionAuthority,
  interruptEventInitial,
} from '@/backend/services/session';
import { workspaceDataService } from '@/backend/services/workspace';
import type {
  ProviderSource,
  RuntimeStopEvidence,
  UnprovenStopReason,
} from '@/shared/event-agent-delivery';
import type { EventRunRecoveryInput, EventRunRecoveryContext } from '@/shared/event-agent-recovery';
import { childHeldOutcome } from '@/shared/event-child-rest';
import { observeChildRest } from './event-child-rest.orchestrator';

const blocked = (reason: string) => ({ status: 'BLOCKED' as const, reason });
class RetryResourcesUnavailable extends Error {}
function worktreeAvailable(path: string | null): boolean {
  try {
    if (!(path && statSync(path, { throwIfNoEntry: false })?.isDirectory())) {
      return false;
    }
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function assertWorktree(path: string | null) {
  if (!worktreeAvailable(path)) {
    throw new RetryResourcesUnavailable('Reserved worktree is unavailable');
  }
}
async function retryResourceFacts(
  input: EventRunRecoveryContext,
  inspection: Awaited<ReturnType<typeof eventRunRecovery.inspect>>
) {
  const path = inspection.retryResourcesAvailable
    ? ((await workspaceDataService.findById(input.claim.reservedWorkspaceId))?.worktreePath ?? null)
    : null;
  return { path, available: worktreeAvailable(path) };
}
export async function inspectEventRun(input: EventRunRecoveryContext) {
  const children = await observeChildRest(input.claim.reservedWorkspaceId);
  const inspection = await eventRunRecovery.inspect(input, children);
  const resources = await retryResourceFacts(input, inspection);
  const evidence = inspection.run.delivery.evidence;
  const previous = evidence?.resolution;
  const previousProofMissing =
    previous?.action === 'RETRY' &&
    !evidence?.source &&
    !eventOwnedWork.observe(previous.attempt, previous.work.source, previous.stop);
  const observation = evidence?.source
    ? eventOwnedWork.observe(input.attempt, evidence.source, evidence.stop)
    : null;
  const outcome = evidence?.outcome?.result;
  const blocked = previousProofMissing
    ? ('PREVIOUS_WORK_PROOF_UNAVAILABLE' as const)
    : (inspection.blocked ??
      (!evidence?.source
        ? ('SOURCE_UNAVAILABLE' as const)
        : !observation
          ? ('WORK_PROOF_UNAVAILABLE' as const)
          : null));
  return {
    ...inspection,
    childHold: inspection.childHold && {
      ...inspection.childHold,
      // Mirrors ABANDON: FAILED is always kept; COMPLETED only when the run's own work was idle.
      keepsOutcome:
        outcome === 'FAILED' || (!!observation && childHeldOutcome(outcome, 0) !== null),
    },
    retryResourcesAvailable: resources.available,
    retryBlocked: resources.available ? null : 'RESOURCES_UNAVAILABLE',
    delivery:
      inspection.run.delivery.state === 'PENDING'
        ? ('UNSENT' as const)
        : ('REACHED_OR_UNCERTAIN' as const),
    proofAvailable: observation?.proof.mode === 'STOPPED',
    blocked,
    // Same owner precondition the action checks before it can end the run.
    unprovenAbandonAvailable:
      blocked !== null && (await eventSessionAuthority.isOwned(input.attempt.sessionId)),
  };
}
/** ABANDON with an explicit opt-in may end the run when stop or work proof is unavailable. */
const acceptsUnproven = (input: EventRunRecoveryInput) =>
  input.action === 'ABANDON' && input.acceptUnprovenStop === true;
const unproven = (reason: UnprovenStopReason) => ({ status: 'UNPROVEN' as const, reason });
/**
 * Best-effort targeted stop for an unproven Abandon: only the run's own recorded
 * runtime source, never a replacement. Failure is expected (no live handle) and
 * leaves whatever stop evidence was actually observed.
 */
async function tryTargetedStop(
  input: EventRunRecoveryInput,
  source: ProviderSource,
  stop: RuntimeStopEvidence | undefined,
  check: () => void
) {
  if (stop?.status === 'LOCAL_RUNTIME_GROUP_STOPPED') {
    return;
  }
  try {
    await interruptEventInitial(input.attempt.sessionId, 'SYSTEM_STOP', {
      attempt: input.attempt,
      source,
      assertCurrent: check,
    });
  } catch {
    // Ownership loss still aborts the action; anything else only means no proven stop.
    check();
  }
}
/** Without the opt-in a proof block stays BLOCKED; with it, Abandon continues unproven. */
const proofBlock = (input: EventRunRecoveryInput, reason: UnprovenStopReason) =>
  acceptsUnproven(input) ? unproven(reason) : blocked(reason);
/** Scope, child, resource and owner checks before any stop. */
async function readyForStop(input: EventRunRecoveryInput, check: () => void) {
  const rest = await observeChildRest(input.claim.reservedWorkspaceId);
  check();
  const inspection = await eventRunRecovery.inspect(input, rest);
  check();
  if (inspection.blocked) {
    return proofBlock(input, inspection.blocked);
  }
  if (inspection.childHold && input.action !== 'ABANDON') {
    return blocked('CHILD_WORK_UNPROVEN');
  }
  if (input.action === 'RETRY') {
    const resources = await retryResourceFacts(input, inspection);
    check();
    if (!resources.available) {
      return blocked('RESOURCES_UNAVAILABLE');
    }
  }
  // Logical cancellation is already effective if this lookup fails or stalls.
  if (!(await eventSessionAuthority.isOwned(input.attempt.sessionId))) {
    return blocked('OWNER_UNAVAILABLE');
  }
  check();
  const evidence = inspection.run.delivery.evidence;
  if (!evidence?.source) {
    return proofBlock(input, 'SOURCE_UNAVAILABLE');
  }
  return { status: 'READY' as const, evidence, source: evidence.source };
}
async function stopAndRead(
  input: EventRunRecoveryInput,
  source: ProviderSource,
  stop: RuntimeStopEvidence | undefined,
  current: () => void
) {
  if (stop?.status !== 'LOCAL_RUNTIME_GROUP_STOPPED') {
    await interruptEventInitial(input.attempt.sessionId, 'SYSTEM_STOP', {
      attempt: input.attempt,
      source,
      assertCurrent: current,
    });
  }
  current();
  const read = await eventRunRecovery.inspect(input);
  current();
  return read;
}
async function stopAndObserve(input: EventRunRecoveryInput, check: () => void) {
  const ready = await readyForStop(input, check);
  if (ready.status !== 'READY') {
    return ready;
  }
  const { evidence, source } = ready;
  const guard = eventOwnedWork.stopGuard(input.attempt, source);
  if (!guard) {
    if (acceptsUnproven(input)) {
      await tryTargetedStop(input, source, evidence.stop, check);
    }
    return proofBlock(input, 'WORK_PROOF_UNAVAILABLE');
  }
  // Whether the run's own work was idle before recovery stops it: only children held it.
  const ownWorkIdle = !!eventOwnedWork.observe(input.attempt, source, evidence.stop);
  const current = () => {
    check();
    guard();
  };
  const stopped = await stopAndRead(input, source, evidence.stop, current).catch(
    (error: unknown) => {
      if (!acceptsUnproven(input)) {
        throw error;
      }
      // Ownership loss still aborts the action; anything else only means no proven stop.
      check();
      return null;
    }
  );
  const observation =
    stopped && eventOwnedWork.observe(input.attempt, source, stopped.run.delivery.evidence?.stop);
  if (!stopped || observation?.proof.mode !== 'STOPPED') {
    return proofBlock(input, 'WORK_PROOF_UNAVAILABLE');
  }
  // Re-observe after the stop await so RESOLVE/RETRY decide on the freshest child state.
  const settledRest = await observeChildRest(input.claim.reservedWorkspaceId);
  current();
  if (!settledRest.atRest && input.action !== 'ABANDON') {
    return blocked('CHILD_WORK_UNPROVEN');
  }
  return {
    status: 'PROVED' as const,
    current,
    observation,
    stopped,
    children: { rest: settledRest, ownWorkIdle },
  };
}
/** Called only after the consumer synchronously fences the exact old operation. */
export function resolveEventRun(input: EventRunRecoveryInput, assertOwned: () => void) {
  return eventSessionAuthority
    .observeOwnedWork(async (assertOpen) => {
      const check = () => {
        assertOpen();
        assertOwned();
      };
      check();
      const work = await stopAndObserve(input, check);
      if (work.status === 'BLOCKED') {
        return work;
      }
      if (work.status === 'UNPROVEN') {
        // Decide on the child set as it is now; the owner write rejects any later change.
        const rest = await observeChildRest(input.claim.reservedWorkspaceId);
        check();
        return eventRunRecovery.abandonUnproven(input, work.reason, rest, check);
      }
      const { current, observation, stopped, children } = work;
      let path: string | null = null;
      if (input.action === 'RETRY') {
        const resources = await retryResourceFacts(input, stopped);
        current();
        observation.assertCurrent();
        if (!resources.available) {
          return blocked('RESOURCES_UNAVAILABLE');
        }
        path = resources.path;
      }
      const validate = () => {
        current();
        observation.assertCurrent();
        if (input.action === 'RETRY') {
          assertWorktree(path);
        }
      };
      validate();
      return eventRunRecovery.resolve(input, observation.proof, children, validate);
    })
    .catch((error: unknown) => {
      // A resource lost during the guarded write must roll back, then retain its
      // resource classification instead of masquerading as lost proof/ownership.
      if (error instanceof RetryResourcesUnavailable) {
        return blocked('RESOURCES_UNAVAILABLE');
      }
      throw error;
    });
}
