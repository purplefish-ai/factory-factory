import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk';
import {
  asString,
  dedupeLocations,
  isCommandExecutionSessionHandoffOutput,
  isRecord,
  resolveToolCallId,
  toToolStatus,
  toTurnItemKey,
} from './acp-adapter-utils';
import type {
  AdapterSession,
  CodexClient,
  PendingTurnCompletion,
  ToolCallState,
} from './adapter-state';
import { knownCodexNotificationSchema, threadReadResponseSchema } from './codex-zod';

type ThreadReadItem = ReturnType<
  typeof threadReadResponseSchema.parse
>['thread']['turns'][number]['items'][number];

type CodexNotificationPayload = {
  method: string;
  params?: unknown;
};

type StreamEventHandlerDeps = {
  codex: Pick<CodexClient, 'request'>;
  sessionIdByThreadId: Map<string, string>;
  sessions: Map<string, AdapterSession>;
  requireSession: (sessionId: string) => AdapterSession;
  emitSessionUpdate: (sessionId: string, update: SessionUpdate) => Promise<void>;
  reportShapeDrift: (event: string, details?: unknown) => void;
  buildToolCallState: (
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    turnId: string
  ) => ToolCallState | null;
  emitReasoningThoughtChunkFromItem: (
    sessionId: string,
    item: Record<string, unknown>
  ) => Promise<void>;
  shouldHoldTurnForPlanApproval: (
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    turnId: string
  ) => boolean;
  holdTurnUntilPlanApprovalResolves: (session: AdapterSession, turnId: string) => void;
  maybeRequestPlanApproval: (
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    turnId: string,
    completedPlanToolCall: ToolCallState
  ) => Promise<void>;
  hasPendingPlanApprovals: (session: AdapterSession, turnId: string) => boolean;
  settleTurn: (session: AdapterSession, stopReason: StopReason) => void;
  emitTurnFailureMessage: (sessionId: string, errorMessage: string) => Promise<void>;
};

export class CodexStreamEventHandler {
  constructor(private readonly deps: StreamEventHandlerDeps) {}

  async replayThreadHistory(sessionId: string, threadId: string): Promise<void> {
    const session = this.deps.requireSession(sessionId);
    const threadReadRaw = await this.deps.codex.request('thread/read', {
      threadId,
      includeTurns: true,
    });
    const threadRead = threadReadResponseSchema.parse(threadReadRaw);

    for (const turn of threadRead.thread.turns) {
      for (const item of turn.items) {
        await this.replayThreadHistoryItem(session, sessionId, turn.id, item);
      }
    }
  }

  async handleCodexNotification(notification: CodexNotificationPayload): Promise<void> {
    const parsed = knownCodexNotificationSchema.safeParse(notification);
    if (!parsed.success) {
      this.deps.reportShapeDrift('malformed_notification', {
        method: notification.method,
        issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message),
      });
      return;
    }

    const typedNotification = parsed.data;
    if (typedNotification.method === 'error' || typedNotification.method === 'turn/started') {
      return;
    }

    const sessionId = this.deps.sessionIdByThreadId.get(typedNotification.params.threadId);
    if (!sessionId) {
      return;
    }

    const session = this.deps.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (typedNotification.method === 'item/agentMessage/delta') {
      await this.deps.emitSessionUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: typedNotification.params.delta,
        },
      });
      return;
    }

    if (typedNotification.method === 'item/plan/delta') {
      await this.handlePlanDelta(
        sessionId,
        session,
        typedNotification.params.itemId,
        typedNotification.params.delta
      );
      return;
    }

    if (typedNotification.method === 'item/reasoning/summaryTextDelta') {
      await this.emitReasoningThoughtDelta(
        sessionId,
        session,
        typedNotification.params.turnId,
        typedNotification.params.itemId,
        typedNotification.params.delta
      );
      return;
    }

    if (typedNotification.method === 'item/commandExecution/outputDelta') {
      await this.emitToolCallProgress(
        sessionId,
        session,
        typedNotification.params.turnId,
        typedNotification.params.itemId,
        typedNotification.params.delta,
        'commandExecution'
      );
      return;
    }

    if (typedNotification.method === 'item/fileChange/outputDelta') {
      await this.emitToolCallProgress(
        sessionId,
        session,
        typedNotification.params.turnId,
        typedNotification.params.itemId,
        typedNotification.params.delta,
        'fileChange'
      );
      return;
    }

    if (typedNotification.method === 'item/mcpToolCall/progress') {
      await this.emitToolCallProgress(
        sessionId,
        session,
        typedNotification.params.turnId,
        typedNotification.params.itemId,
        typedNotification.params.message,
        'mcpToolCall'
      );
      return;
    }

    if (typedNotification.method === 'item/started') {
      await this.handleItemStarted(
        session,
        typedNotification.params.item as { type: string; id: string } & Record<string, unknown>,
        typedNotification.params.turnId
      );
      return;
    }

    if (typedNotification.method === 'item/completed') {
      await this.handleItemCompleted(
        session,
        typedNotification.params.item as { type: string; id: string } & Record<string, unknown>,
        typedNotification.params.turnId
      );
      return;
    }

    if (typedNotification.method === 'turn/completed') {
      await this.handleTurnCompletedNotification(
        session,
        typedNotification.params.turn.id,
        typedNotification.params.turn.status,
        typedNotification.params.turn.error?.message
      );
    }
  }

  private async replayThreadHistoryItem(
    session: AdapterSession,
    sessionId: string,
    turnId: string,
    item: ThreadReadItem
  ): Promise<void> {
    if (item.type === 'userMessage') {
      await this.replayUserMessageHistoryItem(sessionId, item as Record<string, unknown>);
      return;
    }

    if (item.type === 'agentMessage') {
      await this.replayAgentMessageHistoryItem(sessionId, item as Record<string, unknown>);
      return;
    }

    await this.replayToolLikeHistoryItem(session, sessionId, turnId, item);
  }

  private async replayUserMessageHistoryItem(
    sessionId: string,
    item: Record<string, unknown>
  ): Promise<void> {
    const contentBlocks = Array.isArray(item.content) ? item.content : [];
    for (const content of contentBlocks) {
      if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
        continue;
      }
      await this.deps.emitSessionUpdate(sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: content.text },
      });
    }
  }

  private async replayAgentMessageHistoryItem(
    sessionId: string,
    item: Record<string, unknown>
  ): Promise<void> {
    const text = asString(item.text);
    if (!text) {
      return;
    }

    await this.deps.emitSessionUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  }

  private async replayToolLikeHistoryItem(
    session: AdapterSession,
    sessionId: string,
    turnId: string,
    item: { type: string; id: string } & Record<string, unknown>
  ): Promise<void> {
    if (item.type === 'reasoning') {
      await this.deps.emitSessionUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: resolveToolCallId({ itemId: item.id, source: item }),
        title: 'reasoning',
        kind: 'think',
        status: 'completed',
        rawInput: item,
        rawOutput: item,
      });
      await this.deps.emitReasoningThoughtChunkFromItem(sessionId, item);
      session.replayedTurnItemKeys.add(toTurnItemKey(turnId, item.id));
      return;
    }

    const toolInfo = this.deps.buildToolCallState(session, item, turnId);
    if (!toolInfo) {
      this.deps.reportShapeDrift('unhandled_replay_item', {
        turnId,
        itemType: item.type,
        itemId: item.id,
      });
      return;
    }

    await this.deps.emitSessionUpdate(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: toolInfo.toolCallId,
      title: toolInfo.title,
      kind: toolInfo.kind,
      status: 'completed',
      rawInput: item,
      rawOutput: item,
    });
    session.replayedTurnItemKeys.add(toTurnItemKey(turnId, item.id));
  }

  private async handlePlanDelta(
    sessionId: string,
    session: AdapterSession,
    itemId: string,
    delta: string
  ): Promise<void> {
    const previous = session.planTextByItemId.get(itemId) ?? '';
    const next = `${previous}${delta}`;
    session.planTextByItemId.set(itemId, next);

    await this.deps.emitSessionUpdate(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        {
          content: next,
          priority: 'medium',
          status: 'in_progress',
        },
      ],
    });
  }

  private isReplayedTurnItem(session: AdapterSession, turnId: string, itemId: string): boolean {
    return session.replayedTurnItemKeys.has(toTurnItemKey(turnId, itemId));
  }

  private async emitReasoningThoughtDelta(
    sessionId: string,
    session: AdapterSession,
    turnId: string,
    itemId: string,
    delta: string
  ): Promise<void> {
    if (this.isReplayedTurnItem(session, turnId, itemId)) {
      return;
    }
    if (delta.length === 0) {
      return;
    }

    const existing = session.toolCallsByItemId.get(itemId);
    if (!existing) {
      const toolCallId = resolveToolCallId({ itemId });
      session.toolCallsByItemId.set(itemId, {
        toolCallId,
        title: 'reasoning',
        kind: 'think',
        locations: [],
      });
      await this.deps.emitSessionUpdate(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'reasoning',
        kind: 'think',
        status: 'pending',
        rawInput: {
          type: 'reasoning',
          id: itemId,
        },
      });
      await this.deps.emitSessionUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        title: 'reasoning',
        kind: 'think',
        status: 'in_progress',
      });
    }

    session.reasoningDeltaItemIds.add(itemId);
    await this.deps.emitSessionUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: delta },
    });
  }

  private async emitToolCallProgress(
    sessionId: string,
    session: AdapterSession,
    turnId: string,
    itemId: string,
    output: string,
    source: 'commandExecution' | 'fileChange' | 'mcpToolCall'
  ): Promise<void> {
    if (this.isReplayedTurnItem(session, turnId, itemId)) {
      return;
    }
    const toolCall = session.toolCallsByItemId.get(itemId);
    if (!toolCall) {
      this.deps.reportShapeDrift('tool_progress_without_tool_call', { turnId, itemId });
      return;
    }

    if (session.syntheticallyCompletedToolItemIds.has(itemId)) {
      return;
    }

    if (source === 'commandExecution' && isCommandExecutionSessionHandoffOutput(output)) {
      session.syntheticallyCompletedToolItemIds.add(itemId);
      await this.deps.emitSessionUpdate(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: toolCall.toolCallId,
        status: 'completed',
        kind: toolCall.kind,
        title: toolCall.title,
        ...(toolCall.locations.length > 0 ? { locations: toolCall.locations } : {}),
        rawOutput: output,
      });
      return;
    }

    await this.deps.emitSessionUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: toolCall.toolCallId,
      status: 'in_progress',
      ...(toolCall.locations.length > 0 ? { locations: toolCall.locations } : {}),
      rawOutput: output,
    });
  }

  private async handleTurnCompletedNotification(
    session: AdapterSession,
    turnId: string,
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress',
    errorMessage?: string
  ): Promise<void> {
    if (status === 'inProgress') {
      return;
    }

    const completionStatus = status;
    if (this.shouldDeferTurnCompletion(session, turnId, completionStatus)) {
      session.pendingTurnCompletionsByTurnId.set(
        turnId,
        this.buildPendingTurnCompletion(completionStatus, errorMessage)
      );
      return;
    }

    await this.finalizeTurnCompletion(session, completionStatus, errorMessage);
  }

  private shouldDeferTurnCompletion(
    session: AdapterSession,
    turnId: string,
    status: 'completed' | 'interrupted' | 'failed'
  ): boolean {
    if (!session.activeTurn || session.activeTurn.turnId !== turnId) {
      return true;
    }
    return status !== 'interrupted' && this.deps.hasPendingPlanApprovals(session, turnId);
  }

  private buildPendingTurnCompletion(
    status: 'completed' | 'interrupted' | 'failed',
    errorMessage?: string
  ): PendingTurnCompletion {
    const stopReason = status === 'interrupted' ? 'cancelled' : 'end_turn';
    if (status === 'failed' && errorMessage) {
      return { stopReason, errorMessage };
    }
    return { stopReason };
  }

  private async finalizeTurnCompletion(
    session: AdapterSession,
    status: 'completed' | 'interrupted' | 'failed',
    errorMessage?: string
  ): Promise<void> {
    if (status === 'interrupted') {
      this.deps.settleTurn(session, 'cancelled');
      return;
    }

    if (status === 'failed' && errorMessage) {
      await this.deps.emitTurnFailureMessage(session.sessionId, errorMessage);
    }

    if (status === 'failed') {
      this.deps.settleTurn(session, 'end_turn');
      return;
    }

    this.deps.settleTurn(session, session.activeTurn?.cancelRequested ? 'cancelled' : 'end_turn');
  }

  private async handleItemStarted(
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    turnId: string
  ): Promise<void> {
    if (this.isReplayedTurnItem(session, turnId, item.id)) {
      return;
    }

    if (item.type === 'reasoning') {
      const existing = session.toolCallsByItemId.get(item.id);
      const toolInfo =
        existing ??
        ({
          toolCallId: resolveToolCallId({
            itemId: item.id,
            source: item,
          }),
          title: 'reasoning',
          kind: 'think',
          locations: [],
        } satisfies ToolCallState);
      if (!existing) {
        session.syntheticallyCompletedToolItemIds.delete(item.id);
        session.toolCallsByItemId.set(item.id, toolInfo);
        await this.deps.emitSessionUpdate(session.sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: toolInfo.toolCallId,
          title: toolInfo.title,
          kind: toolInfo.kind,
          status: 'pending',
          rawInput: item,
        });
      }
      await this.deps.emitSessionUpdate(session.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: toolInfo.toolCallId,
        title: toolInfo.title,
        kind: toolInfo.kind,
        status: 'in_progress',
      });
      return;
    }

    const toolInfo = this.deps.buildToolCallState(session, item, turnId);
    if (!toolInfo) {
      this.deps.reportShapeDrift('unhandled_item_started_type', {
        turnId,
        itemType: item.type,
        itemId: item.id,
      });
      return;
    }

    session.syntheticallyCompletedToolItemIds.delete(item.id);
    session.toolCallsByItemId.set(item.id, toolInfo);

    await this.deps.emitSessionUpdate(session.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: toolInfo.toolCallId,
      title: toolInfo.title,
      kind: toolInfo.kind,
      status: 'pending',
      ...(toolInfo.locations.length > 0 ? { locations: toolInfo.locations } : {}),
      rawInput: item,
    });

    const itemStatus = toToolStatus(item.status);
    if (itemStatus === 'in_progress') {
      await this.deps.emitSessionUpdate(session.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: toolInfo.toolCallId,
        status: 'in_progress',
      });
    }
  }

  private async handleItemCompleted(
    session: AdapterSession,
    item: { type: string; id: string } & Record<string, unknown>,
    turnId: string
  ): Promise<void> {
    if (this.isReplayedTurnItem(session, turnId, item.id)) {
      return;
    }

    if (item.type === 'reasoning') {
      const existing = session.toolCallsByItemId.get(item.id);
      const reasoningToolCallId =
        existing?.toolCallId ??
        resolveToolCallId({
          itemId: item.id,
          source: item,
        });
      if (existing) {
        await this.deps.emitSessionUpdate(session.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: reasoningToolCallId,
          title: existing.title,
          kind: existing.kind,
          status: toToolStatus(item.status) ?? 'completed',
          rawOutput: item,
        });
      } else {
        await this.deps.emitSessionUpdate(session.sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: reasoningToolCallId,
          title: 'reasoning',
          kind: 'think',
          status: toToolStatus(item.status) ?? 'completed',
          rawInput: item,
          rawOutput: item,
        });
      }
      session.toolCallsByItemId.delete(item.id);
      session.syntheticallyCompletedToolItemIds.delete(item.id);

      const sawDelta = session.reasoningDeltaItemIds.has(item.id);
      session.reasoningDeltaItemIds.delete(item.id);
      if (!sawDelta) {
        await this.deps.emitReasoningThoughtChunkFromItem(session.sessionId, item);
      }
      return;
    }

    const existing = session.toolCallsByItemId.get(item.id);
    if (!existing) {
      this.deps.reportShapeDrift('item_completed_without_started_state', {
        turnId,
        itemType: item.type,
        itemId: item.id,
      });
      return;
    }

    if (this.deps.shouldHoldTurnForPlanApproval(session, item, turnId)) {
      this.deps.holdTurnUntilPlanApprovalResolves(session, turnId);
    }

    const statusFromItem = toToolStatus(item.status);
    const status = statusFromItem ?? 'completed';
    const completionLocations = this.extractLocations(item);
    const locations = dedupeLocations([...existing.locations, ...completionLocations]);

    await this.deps.emitSessionUpdate(session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: existing.toolCallId,
      status,
      kind: existing.kind,
      title: existing.title,
      ...(locations.length > 0 ? { locations } : {}),
      rawOutput: item,
    });

    session.toolCallsByItemId.delete(item.id);
    session.syntheticallyCompletedToolItemIds.delete(item.id);

    await this.deps.maybeRequestPlanApproval(session, item, turnId, existing);
  }

  private extractLocations(item: unknown): Array<{ path: string; line?: number | null }> {
    if (!isRecord(item) || item.type !== 'fileChange') {
      return [];
    }

    const changes = item.changes;
    if (!Array.isArray(changes)) {
      return [];
    }

    const locations: Array<{ path: string }> = [];
    for (const change of changes) {
      if (!isRecord(change)) {
        continue;
      }
      const path = asString(change.path);
      if (!path) {
        continue;
      }
      locations.push({ path });
    }

    return locations;
  }
}
