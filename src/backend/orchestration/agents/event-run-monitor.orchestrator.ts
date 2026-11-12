import {
  AgentRunMonitorService,
  eventRunLaunch,
  type EventLaunchClaim,
} from '@/backend/services/agent-definition';
import {
  eventOwnedWork,
  eventSessionAuthority,
  interruptEventInitial,
  acpRuntimeManager,
} from '@/backend/services/session';
import { workspacePrSnapshotService, workspaceDataService } from '@/backend/services/workspace';
import { compactAgentRunResult } from '@/shared/agent-run-result';
import { turnLimitMs } from '@/shared/turn-limit';
import { observeChildRest } from './event-child-rest.orchestrator';

const monitor = new AgentRunMonitorService();
/** Coordinates public owner reads without starting/restoring a provider. */
export function observeEventRun(
  claim: EventLaunchClaim,
  assertOwned: () => void = () => undefined
) {
  return eventSessionAuthority.observeOwnedWork(async (assertOpen) => {
    const check = () => {
      assertOpen();
      assertOwned();
    };
    check();
    let run = await eventRunLaunch.read(claim);
    check();
    const workspace = await workspaceDataService.findById(claim.reservedWorkspaceId);
    check();
    const { result, children } = await observeResultsAndChildren(
      claim.reservedWorkspaceId,
      !!workspace,
      check
    );
    const attempt = {
      runId: claim.runId,
      sessionId: claim.reservedSessionId,
      workerGeneration: claim.workerGeneration,
      attemptGeneration: claim.attemptGeneration,
      messageId: run.delivery.messageId,
      sendAttemptId: run.delivery.sendAttemptId,
    };
    const source = run.delivery.evidence?.source;
    const cause = interruptionCause(run, workspace?.status);
    const initialFinished =
      !!run.delivery.evidence?.outcome &&
      !!workspace &&
      workspace.status !== 'ARCHIVING' &&
      workspace.status !== 'ARCHIVED';
    const live = acpRuntimeManager.getRuntimeSource(attempt.sessionId);
    const idle = source ? eventOwnedWork.observe(attempt, source) : null;
    if (
      source &&
      cause &&
      (!(initialFinished && live) || idle) &&
      run.delivery.evidence?.stop?.status !== 'LOCAL_RUNTIME_GROUP_STOPPED'
    ) {
      await interruptEventInitial(attempt.sessionId, cause, {
        attempt,
        source,
        assertCurrent: () => {
          check();
          if (initialFinished && live) {
            idle?.assertWorkCurrent();
          }
        },
      }).catch(() => {
        // Unavailable/replaced ownership cannot authorize a stop or release capacity.
        check();
      });
      check();
      run = await eventRunLaunch.read(claim);
      check();
    }
    const evidence = run.delivery.evidence;
    const observation = evidence?.source
      ? eventOwnedWork.observe(attempt, evidence.source, evidence.stop)
      : null;
    const settled = await monitor.observeRun(
      claim,
      attempt,
      result,
      children,
      observation?.proof ?? null,
      () => {
        check();
        observation?.assertCurrent();
      }
    );
    if (settled === 'SETTLED') {
      eventOwnedWork.forget(claim.reservedSessionId);
    }
    return settled;
  });
}

/** The run's PR links (own first, then children's, under the shared cap) and child rest. */
async function observeResultsAndChildren(
  workspaceId: string,
  workspaceExists: boolean,
  check: () => void
) {
  const prs = workspaceExists ? await workspacePrSnapshotService.list(workspaceId) : [];
  check();
  const children = await observeChildRest(workspaceId);
  check();
  for (const child of children.children) {
    prs.push(...(await workspacePrSnapshotService.list(child.workspaceId)));
    check();
  }
  return { result: compactAgentRunResult(prs), children };
}

function interruptionCause(
  run: Awaited<ReturnType<typeof eventRunLaunch.read>>,
  workspaceStatus?: string
) {
  const evidence = run.delivery.evidence;
  if (!evidence?.source || evidence.stop?.cause === 'SHUTDOWN') {
    return null;
  }
  if (workspaceStatus === 'ARCHIVED' || workspaceStatus === 'ARCHIVING') {
    return 'WORKSPACE_ARCHIVED';
  }
  if (!workspaceStatus) {
    return 'SYSTEM_STOP';
  }
  if (evidence.outcome) {
    return evidence.outcome.result === 'COMPLETED' ? null : 'SYSTEM_STOP';
  }
  if (evidence.stop) {
    return evidence.stop.cause;
  }
  const timeoutMs = turnLimitMs(run.effectiveExecution?.turnLimitMinutes);
  if (
    timeoutMs !== undefined &&
    run.delivery.sendingAt &&
    Date.now() >= run.delivery.sendingAt.getTime() + timeoutMs
  ) {
    return 'TIMEOUT';
  }
  return null;
}
