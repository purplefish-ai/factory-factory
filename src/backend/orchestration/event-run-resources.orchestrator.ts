import {
  type eventRunLaunch,
  freezeEventExecution,
  readEventExecutionBinding,
  type EventLaunchClaim,
} from '@/backend/services/agent-definition';
import { codexAccountService } from '@/backend/services/codex-accounts';
import { createLogger } from '@/backend/services/logger.service';
import { sessionDataService } from '@/backend/services/session';
import { WorkspaceCreationService } from '@/backend/services/workspace';
import { eventAgentExecutionSchema, type EventAgentExecution } from '@/shared/event-agent-launch';

const creation = new WorkspaceCreationService({ logger: createLogger('event-launch') });
type Run = Awaited<ReturnType<typeof eventRunLaunch.read>>;

/** Account reservation lasts through freeze and session insertion, never setup or a provider turn. */
export async function createEventLaunchResources(
  claim: EventLaunchClaim,
  run: Run,
  check: () => void
) {
  check();
  const binding = await readEventExecutionBinding(claim);
  const create = async (execution: EventAgentExecution) => {
    check();
    await freezeEventExecution({
      claim,
      messageId: binding.messageId,
      sendAttemptId: binding.sendAttemptId,
      execution,
    });
    check();
    await creation.createEventWorkspaceOnce({
      type: 'EVENT_AGENT',
      runId: claim.runId,
      projectId: run.projectId,
      reservedWorkspaceId: claim.reservedWorkspaceId,
      reservedSessionId: claim.reservedSessionId,
      initialMessageId: claim.initialMessageId,
      name: run.definition.name,
      execution,
      input: run.input,
      ...issueLink(run.input.sourceUrl),
    });
    check();
    await sessionDataService.createEventSessionOnce({
      id: claim.reservedSessionId,
      workspaceId: claim.reservedWorkspaceId,
      runId: claim.runId,
      execution,
    });
  };
  if (binding.execution) {
    await create(binding.execution);
  } else if (run.execution.provider === 'CODEX') {
    await codexAccountService.withAccountReservation(
      { model: run.execution.model, reasoningEffort: run.execution.reasoningEffort },
      (id) => create(resolveExecution(run, id))
    );
  } else {
    await create(resolveExecution(run, null));
  }
  return binding;
}
function resolveExecution(run: Run, codexAccountId: string | null) {
  return eventAgentExecutionSchema.parse({
    ...run.execution,
    reasoningEffort: run.execution.reasoningEffort ?? null,
    codexAccountId,
    startupModePreset: 'non_interactive',
    accessMode: run.execution.provider === 'CLAUDE' ? 'bypassPermissions' : 'workspace-write',
    planModeEnabled: false,
  });
}
function issueLink(sourceUrl: string | undefined) {
  if (!sourceUrl) {
    return {};
  }
  const url = new URL(sourceUrl);
  const match = /^\/[^/]+\/[^/]+\/issues\/([1-9]\d*)$/.exec(url.pathname);
  const number = Number(match?.[1]);
  return url.hostname === 'github.com' && Number.isSafeInteger(number) && number > 0
    ? { issue: { number, url: sourceUrl } }
    : {};
}
