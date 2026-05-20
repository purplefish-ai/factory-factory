import type {
  AgentSideConnection,
  SessionConfigOption,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import type { AdapterSession, CollaborationModeEntry, ToolCallState } from './adapter-state';
import { extractPlanText, isPlanLikeMode } from './codex-adapter-parsing';
import {
  getCollaborationModeValues,
  resolveCollaborationModeLabel,
} from './session-config-resolver';

const PLAN_EXIT_MODE_PREFERENCE = ['default', 'code', 'acceptEdits', 'ask'] as const;

type PlanItem = { type: string; id: string } & Record<string, unknown>;

function buildPlanApprovalInput(planText: string, sourceItemId: string): Record<string, unknown> {
  return {
    type: 'ExitPlanMode',
    plan: { type: 'text', text: planText },
    reason: 'Plan proposed. Approve to exit plan mode and continue implementation.',
    source: 'codex_plan_completion',
    sourceItemId,
  };
}

function extractPlanApprovalText(
  session: AdapterSession,
  item: { id: string } & Record<string, unknown>
): string | null {
  const bufferedText = session.planTextByItemId.get(item.id);
  if (bufferedText && bufferedText.trim().length > 0) {
    return bufferedText;
  }
  const fromPlanField = extractPlanText(item.plan);
  if (fromPlanField && fromPlanField.trim().length > 0) {
    return fromPlanField;
  }
  const fromTextField = extractPlanText(item.text);
  if (fromTextField && fromTextField.trim().length > 0) {
    return fromTextField;
  }
  return null;
}

function getPlanExitModePriority(modeId: string): number {
  const normalized = modeId.toLowerCase();
  const index = PLAN_EXIT_MODE_PREFERENCE.findIndex(
    (preferred) => preferred.toLowerCase() === normalized
  );
  return index >= 0 ? index : PLAN_EXIT_MODE_PREFERENCE.length;
}

function comparePlanExitModePreference(left: string, right: string): number {
  const priorityDiff = getPlanExitModePriority(left) - getPlanExitModePriority(right);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  return left.localeCompare(right);
}

function buildPlanApprovalOptions(
  session: AdapterSession,
  collaborationModes: CollaborationModeEntry[]
): {
  options: Array<{
    optionId: string;
    name: string;
    kind: 'allow_once' | 'reject_once';
  }>;
  approvableModeIds: Set<string>;
} {
  const currentMode = session.defaults.collaborationMode;
  const availableModes = getCollaborationModeValues(collaborationModes, currentMode);
  const nonPlanModes = availableModes
    .filter((modeId) => !isPlanLikeMode(modeId))
    .sort(comparePlanExitModePreference);

  const approvableModeIds = new Set<string>(nonPlanModes);
  const options: Array<{ optionId: string; name: string; kind: 'allow_once' | 'reject_once' }> =
    nonPlanModes.map((modeId) => ({
      optionId: modeId,
      name: `Approve and switch to ${resolveCollaborationModeLabel(collaborationModes, modeId)}`,
      kind: 'allow_once' as const,
    }));

  options.push({
    optionId: currentMode,
    name: 'Keep planning',
    kind: 'reject_once',
  });

  return { options, approvableModeIds };
}

export function shouldHoldTurnForPlanApproval(
  session: AdapterSession,
  item: PlanItem,
  turnId: string
): boolean {
  return (
    item.type === 'plan' &&
    isPlanLikeMode(session.defaults.collaborationMode) &&
    !session.planApprovalRequestedByTurnId.has(turnId) &&
    extractPlanApprovalText(session, item) !== null
  );
}

export function holdTurnUntilPlanApprovalResolves(session: AdapterSession, turnId: string): void {
  if (hasPendingPlanApprovals(session, turnId)) {
    return;
  }
  session.pendingPlanApprovalsByTurnId.set(turnId, 1);
}

export function hasPendingPlanApprovals(session: AdapterSession, turnId: string): boolean {
  return (session.pendingPlanApprovalsByTurnId.get(turnId) ?? 0) > 0;
}

async function releaseTurnHoldForPlanApproval(params: {
  session: AdapterSession;
  turnId: string;
  emitTurnFailureMessage: (sessionId: string, errorMessage: string) => Promise<void>;
  settleTurn: (session: AdapterSession, stopReason: StopReason) => void;
}): Promise<void> {
  const { session, turnId, emitTurnFailureMessage, settleTurn } = params;
  const pendingCount = session.pendingPlanApprovalsByTurnId.get(turnId) ?? 0;
  if (pendingCount <= 1) {
    session.pendingPlanApprovalsByTurnId.delete(turnId);
  } else {
    session.pendingPlanApprovalsByTurnId.set(turnId, pendingCount - 1);
  }

  if (hasPendingPlanApprovals(session, turnId)) {
    return;
  }

  if (!session.activeTurn || session.activeTurn.settled || session.activeTurn.turnId !== turnId) {
    return;
  }

  const deferredCompletion = session.pendingTurnCompletionsByTurnId.get(turnId);
  if (!deferredCompletion) {
    return;
  }

  session.pendingTurnCompletionsByTurnId.delete(turnId);
  if (deferredCompletion.errorMessage) {
    await emitTurnFailureMessage(session.sessionId, deferredCompletion.errorMessage);
  }
  settleTurn(session, deferredCompletion.stopReason);
}

export async function maybeRequestPlanApproval(params: {
  session: AdapterSession;
  item: PlanItem;
  turnId: string;
  completedPlanToolCall: ToolCallState;
  connection: AgentSideConnection;
  collaborationModes: CollaborationModeEntry[];
  buildConfigOptions: (session: AdapterSession) => SessionConfigOption[];
  emitSessionUpdate: (sessionId: string, update: SessionUpdate) => Promise<void>;
  emitTurnFailureMessage: (sessionId: string, errorMessage: string) => Promise<void>;
  settleTurn: (session: AdapterSession, stopReason: StopReason) => void;
}): Promise<void> {
  const {
    session,
    item,
    turnId,
    completedPlanToolCall,
    connection,
    collaborationModes,
    buildConfigOptions,
    emitSessionUpdate,
    emitTurnFailureMessage,
    settleTurn,
  } = params;
  if (item.type !== 'plan') {
    return;
  }
  if (!isPlanLikeMode(session.defaults.collaborationMode)) {
    return;
  }
  if (session.planApprovalRequestedByTurnId.has(turnId)) {
    return;
  }

  const planText = extractPlanApprovalText(session, item);
  if (!planText) {
    return;
  }

  session.planApprovalRequestedByTurnId.add(turnId);
  holdTurnUntilPlanApprovalResolves(session, turnId);
  const approvalToolCallId = `${completedPlanToolCall.toolCallId}:exit-plan`;
  const approvalInput = buildPlanApprovalInput(planText, item.id);

  await emitSessionUpdate(session.sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: approvalToolCallId,
    title: 'ExitPlanMode',
    kind: 'switch_mode',
    status: 'pending',
    rawInput: approvalInput,
  });

  try {
    const { options: planApprovalOptions, approvableModeIds } = buildPlanApprovalOptions(
      session,
      collaborationModes
    );
    if (approvableModeIds.size === 0) {
      await emitSessionUpdate(session.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: approvalToolCallId,
        kind: 'switch_mode',
        title: 'ExitPlanMode',
        status: 'failed',
        rawOutput: 'Plan proposed, but no non-plan collaboration mode is available.',
      });
      return;
    }

    const permissionResult = await connection.requestPermission({
      sessionId: session.sessionId,
      toolCall: {
        toolCallId: approvalToolCallId,
        title: 'ExitPlanMode',
        kind: 'switch_mode',
        status: 'pending',
        rawInput: approvalInput,
      },
      options: planApprovalOptions,
    });

    const selectedMode =
      permissionResult.outcome.outcome === 'selected' &&
      approvableModeIds.has(permissionResult.outcome.optionId)
        ? permissionResult.outcome.optionId
        : null;
    const approved = selectedMode !== null;

    if (selectedMode && session.defaults.collaborationMode !== selectedMode) {
      session.defaults.collaborationMode = selectedMode;
      await emitSessionUpdate(session.sessionId, {
        sessionUpdate: 'config_option_update',
        configOptions: buildConfigOptions(session),
      });
    }

    await emitSessionUpdate(session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: approvalToolCallId,
      kind: 'switch_mode',
      title: 'ExitPlanMode',
      status: approved ? 'completed' : 'failed',
      rawOutput: approved ? 'Plan approved' : 'Plan approval rejected',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitSessionUpdate(session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: approvalToolCallId,
      kind: 'switch_mode',
      title: 'ExitPlanMode',
      status: 'failed',
      rawOutput: `Plan approval failed: ${message}`,
    });
  } finally {
    await releaseTurnHoldForPlanApproval({
      session,
      turnId,
      emitTurnFailureMessage,
      settleTurn,
    });
  }
}
