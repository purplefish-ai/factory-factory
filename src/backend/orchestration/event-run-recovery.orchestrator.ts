import { accessSync, constants, statSync } from 'node:fs';
import { eventRunRecovery } from '@/backend/services/agent-definition';
import {
  eventOwnedWork,
  eventSessionAuthority,
  interruptEventInitial,
} from '@/backend/services/session';
import { workspaceDataService } from '@/backend/services/workspace';
import type { EventRunRecoveryInput, EventRunRecoveryContext } from '@/shared/event-agent-recovery';

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
  const inspection = await eventRunRecovery.inspect(input);
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
  return {
    ...inspection,
    retryResourcesAvailable: resources.available,
    retryBlocked: resources.available ? null : 'RESOURCES_UNAVAILABLE',
    delivery:
      inspection.run.delivery.state === 'PENDING'
        ? ('UNSENT' as const)
        : ('REACHED_OR_UNCERTAIN' as const),
    proofAvailable: observation?.proof.mode === 'STOPPED',
    blocked: previousProofMissing
      ? 'PREVIOUS_WORK_PROOF_UNAVAILABLE'
      : (inspection.blocked ??
        (!evidence?.source
          ? 'SOURCE_UNAVAILABLE'
          : !observation
            ? 'WORK_PROOF_UNAVAILABLE'
            : null)),
  };
}
async function stopAndObserve(input: EventRunRecoveryInput, check: () => void) {
  const inspection = await eventRunRecovery.inspect(input);
  check();
  if (inspection.blocked) {
    return blocked(inspection.blocked);
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
  const source = inspection.run.delivery.evidence?.source;
  if (!source) {
    return blocked('SOURCE_UNAVAILABLE');
  }
  const guard = eventOwnedWork.stopGuard(input.attempt, source);
  if (!guard) {
    return blocked('WORK_PROOF_UNAVAILABLE');
  }
  const current = () => {
    check();
    guard();
  };
  if (inspection.run.delivery.evidence?.stop?.status !== 'LOCAL_RUNTIME_GROUP_STOPPED') {
    await interruptEventInitial(input.attempt.sessionId, 'SYSTEM_STOP', {
      attempt: input.attempt,
      source,
      assertCurrent: current,
    });
  }
  current();
  const stopped = await eventRunRecovery.inspect(input);
  current();
  const observation = eventOwnedWork.observe(
    input.attempt,
    source,
    stopped.run.delivery.evidence?.stop
  );
  if (observation?.proof.mode !== 'STOPPED') {
    return blocked('WORK_PROOF_UNAVAILABLE');
  }
  return { status: 'PROVED' as const, current, observation, stopped };
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
      const { current, observation, stopped } = work;
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
      return eventRunRecovery.resolve(input, observation.proof, validate);
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
