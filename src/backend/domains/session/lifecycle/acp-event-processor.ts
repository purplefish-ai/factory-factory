import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import {
  AcpEventTranslator,
  type AcpRuntimeEvent,
  type AcpRuntimeEventHandlers,
  type AcpRuntimeManager,
} from '@/backend/domains/session/acp';
import { acpTraceLogger } from '@/backend/domains/session/logging/acp-trace-logger.service';
import { sessionFileLogger } from '@/backend/domains/session/logging/session-file-logger.service';
import type { SessionDomainService } from '@/backend/domains/session/session-domain.service';
import { interceptorRegistry } from '@/backend/interceptors/registry';
import type { InterceptorContext, ToolEvent } from '@/backend/interceptors/types';
import { createLogger } from '@/backend/services/logger.service';
import type { AgentMessage, SessionDeltaEvent } from '@/shared/acp-protocol';
import type { SessionConfigService } from './session.config.service';
import type { SessionPermissionService } from './session.permission.service';

const logger = createLogger('session');

type PendingAcpToolCall = {
  toolUseId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  acpKind?: string;
  acpLocations?: Array<{ path: string; line?: number | null }>;
};

type AssistantChunkType = 'text' | 'thinking';

type AcpAssistantStreamState = {
  order: number;
  chunkType: AssistantChunkType;
  accContent: string;
};

export type AcpEventProcessorDependencies = {
  runtimeManager: AcpRuntimeManager;
  sessionDomainService: SessionDomainService;
  sessionPermissionService: SessionPermissionService;
  sessionConfigService: SessionConfigService;
};

export class AcpEventProcessor {
  private readonly runtimeManager: AcpRuntimeManager;
  private readonly sessionDomainService: SessionDomainService;
  private readonly sessionPermissionService: SessionPermissionService;
  private readonly sessionConfigService: SessionConfigService;
  private readonly acpEventTranslator = new AcpEventTranslator(logger);

  /** Per-session assistant chunk accumulation state for ACP streaming. */
  readonly acpStreamState = new Map<string, AcpAssistantStreamState>();
  /** Per-session ACP tool calls that have started but not yet been completed by tool_result. */
  readonly pendingAcpToolCalls = new Map<string, Map<string, PendingAcpToolCall>>();
  /**
   * Suppress transcript-mutating ACP replay events for sessions whose transcript was
   * already hydrated from on-disk history during passive load_session.
   */
  readonly suppressAcpReplayForSession = new Set<string>();
  /** Maps sessionId → workspaceId for bridge calls during sendAcpMessage */
  readonly sessionToWorkspace = new Map<string, string>();
  /** Maps sessionId → workingDir for interceptor context */
  readonly sessionToWorkingDir = new Map<string, string>();

  constructor(options: AcpEventProcessorDependencies) {
    this.runtimeManager = options.runtimeManager;
    this.sessionDomainService = options.sessionDomainService;
    this.sessionPermissionService = options.sessionPermissionService;
    this.sessionConfigService = options.sessionConfigService;
  }

  createRuntimeEventHandler(
    sessionId: string
  ): Pick<AcpRuntimeEventHandlers, 'permissionBridge' | 'onAcpEvent'> {
    const permissionBridge = this.sessionPermissionService.createPermissionBridge(sessionId);

    return {
      permissionBridge,
      onAcpEvent: (sid: string, event: AcpRuntimeEvent) => {
        if (event.type === 'acp_session_update') {
          const { update } = event;
          if (
            update.sessionUpdate === 'user_message_chunk' &&
            'content' in update &&
            update.content?.type === 'text' &&
            typeof update.content.text === 'string'
          ) {
            this.handleAcpUserMessageChunk(sid, update.content.text);
            return;
          }
          const deltas = this.acpEventTranslator.translateSessionUpdate(update);
          if (deltas.length === 0) {
            acpTraceLogger.log(sid, 'translated_delta', {
              sessionUpdate: update.sessionUpdate,
              deltaCount: 0,
            });
          }
          for (const [index, delta] of deltas.entries()) {
            acpTraceLogger.log(sid, 'translated_delta', {
              sessionUpdate: update.sessionUpdate,
              deltaIndex: index,
              delta,
            });
            this.handleAcpDelta(sid, delta as SessionDeltaEvent);
          }
          return;
        }

        if (event.type === 'acp_permission_request') {
          this.sessionPermissionService.handlePermissionRequest(sid, event);
        }
      },
    };
  }

  handleAcpLog(sid: string, payload: Record<string, unknown>): void {
    acpTraceLogger.log(sid, 'raw_acp_event', payload);
    sessionFileLogger.log(sid, 'FROM_CLAUDE_CLI', payload);
  }

  registerSessionContext(
    sessionId: string,
    context: { workspaceId: string; workingDir: string }
  ): void {
    this.sessionToWorkspace.set(sessionId, context.workspaceId);
    this.sessionToWorkingDir.set(sessionId, context.workingDir);
  }

  setReplaySuppression(sessionId: string, suppress: boolean): void {
    if (suppress) {
      this.suppressAcpReplayForSession.add(sessionId);
      return;
    }
    this.suppressAcpReplayForSession.delete(sessionId);
  }

  clearStreamingState(sessionId: string): void {
    this.acpStreamState.delete(sessionId);
  }

  clearReplaySuppression(sessionId: string): void {
    this.suppressAcpReplayForSession.delete(sessionId);
  }

  clearSessionContext(sessionId: string): void {
    this.sessionToWorkspace.delete(sessionId);
    this.sessionToWorkingDir.delete(sessionId);
  }

  clearPendingToolCalls(sessionId: string): void {
    this.pendingAcpToolCalls.delete(sessionId);
  }

  clearSessionState(sessionId: string): void {
    this.clearStreamingState(sessionId);
    this.clearPendingToolCalls(sessionId);
    this.clearReplaySuppression(sessionId);
    this.clearSessionContext(sessionId);
  }

  beginPromptTurn(sessionId: string): void {
    this.pendingAcpToolCalls.set(sessionId, new Map());
  }

  getWorkspaceId(sessionId: string): string | undefined {
    return this.sessionToWorkspace.get(sessionId);
  }

  /**
   * Handle a single translated ACP delta: persist and emit agent_messages,
   * accumulate text chunks, and forward non-message deltas.
   */
  handleAcpDelta(sid: string, delta: SessionDeltaEvent): void {
    this.maybeLiftReplaySuppression(sid);

    if (
      this.suppressAcpReplayForSession.has(sid) &&
      delta.type !== 'config_options_update' &&
      delta.type !== 'slash_commands'
    ) {
      return;
    }

    this.trackPendingAcpToolCalls(sid, delta);

    // When configOptions change mid-session, sync the handle and re-emit capabilities
    if (delta.type === 'config_options_update') {
      const acpHandle = this.runtimeManager.getClient(sid);
      if (acpHandle) {
        const { configOptions } = delta as { configOptions: unknown[] };
        this.sessionConfigService.applyConfigOptionsUpdateDelta(
          sid,
          acpHandle,
          configOptions as SessionConfigOption[]
        );
        return;
      }
    }

    if (delta.type !== 'agent_message') {
      this.sessionDomainService.emitDelta(sid, delta);
      return;
    }

    const data = (delta as { data: AgentMessage }).data;

    // Text/thinking chunks: accumulate into single message, reuse same order
    // so the frontend upserts rather than inserting a new bubble per chunk.
    if (data.type === 'assistant') {
      const accumulated = this.accumulateAcpAssistantContent(sid, data);
      if (accumulated) {
        return;
      }
    }

    // Non-accumulated agent_message (tool_use, result, complex assistant payload): reset accumulator
    this.acpStreamState.delete(sid);
    // Persist to transcript + allocate order in one step
    const order = this.sessionDomainService.appendClaudeEvent(sid, data);
    this.sessionDomainService.emitDelta(sid, { ...delta, order });
  }

  finalizeOrphanedToolCalls(sid: string, reason: string): void {
    const pendingById = this.pendingAcpToolCalls.get(sid);
    if (!pendingById || pendingById.size === 0) {
      this.pendingAcpToolCalls.delete(sid);
      return;
    }

    const toolUseIds = [...pendingById.keys()];
    logger.warn('Finalizing orphaned ACP tool calls without terminal status', {
      sessionId: sid,
      reason,
      count: toolUseIds.length,
      toolUseIds,
    });

    for (const pending of pendingById.values()) {
      const syntheticProgress = {
        type: 'tool_progress',
        tool_use_id: pending.toolUseId,
        tool_name: pending.toolName,
        acpStatus: 'failed',
        elapsed_time_seconds: 0,
        ...(pending.acpKind ? { acpKind: pending.acpKind } : {}),
        ...(pending.acpLocations ? { acpLocations: pending.acpLocations } : {}),
      } as SessionDeltaEvent;
      this.handleAcpDelta(sid, syntheticProgress);

      const syntheticResult = {
        type: 'agent_message',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: pending.toolUseId,
                content: `Tool call did not receive a terminal ACP update (${reason}). Marked as failed locally.`,
                is_error: true,
              },
            ],
          },
        },
      } as SessionDeltaEvent;
      this.handleAcpDelta(sid, syntheticResult);

      acpTraceLogger.log(sid, 'translated_delta', {
        sessionUpdate: 'synthetic_orphan_tool_call',
        delta: syntheticProgress,
      });
      acpTraceLogger.log(sid, 'translated_delta', {
        sessionUpdate: 'synthetic_orphan_tool_call',
        delta: syntheticResult,
      });
    }

    this.pendingAcpToolCalls.delete(sid);
  }

  /**
   * ACP can emit user_message_chunk during both replay (idle) and live sends (working).
   * Live sends are already committed by our send pipeline, so only inject replay chunks.
   */
  private handleAcpUserMessageChunk(sid: string, text: string): void {
    this.maybeLiftReplaySuppression(sid);
    if (this.suppressAcpReplayForSession.has(sid)) {
      return;
    }
    if (this.runtimeManager.isSessionWorking(sid)) {
      return;
    }
    const normalized = text.trim();
    if (normalized.length === 0) {
      return;
    }
    this.sessionDomainService.injectCommittedUserMessage(sid, normalized);
  }

  /**
   * Accumulate ACP assistant text/thinking chunks into a single message at a stable order.
   */
  private accumulateAcpAssistantContent(sid: string, data: AgentMessage): boolean {
    const chunk = this.extractAssistantChunk(data);
    if (!chunk) {
      return false;
    }

    let ss = this.acpStreamState.get(sid);
    if (!ss || ss.chunkType !== chunk.chunkType) {
      ss = {
        order: this.sessionDomainService.allocateOrder(sid),
        chunkType: chunk.chunkType,
        accContent: '',
      };
      this.acpStreamState.set(sid, ss);
    }

    ss.accContent += chunk.content;
    const accMsg: AgentMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content:
          ss.chunkType === 'thinking'
            ? [{ type: 'thinking', thinking: ss.accContent }]
            : [{ type: 'text', text: ss.accContent }],
      },
    };
    this.sessionDomainService.upsertClaudeEvent(sid, accMsg, ss.order);
    this.sessionDomainService.emitDelta(sid, {
      type: 'agent_message',
      data: accMsg,
      order: ss.order,
    } as SessionDeltaEvent & { order: number });
    return true;
  }

  private extractAssistantChunk(
    data: AgentMessage
  ): { chunkType: AssistantChunkType; content: string } | null {
    const content = data.message?.content;
    if (!Array.isArray(content) || content.length !== 1) {
      return null;
    }

    const first = content[0];
    if (first?.type === 'text') {
      return { chunkType: 'text', content: first.text };
    }
    if (first?.type === 'thinking') {
      return { chunkType: 'thinking', content: first.thinking };
    }
    return null;
  }

  private trackPendingAcpToolCalls(sid: string, delta: SessionDeltaEvent): void {
    if (delta.type === 'agent_message') {
      this.trackPendingFromAgentMessage(sid, (delta as { data: AgentMessage }).data);
      return;
    }

    if (delta.type === 'tool_progress') {
      this.trackPendingFromToolProgress(
        sid,
        delta as {
          tool_use_id?: string;
          tool_name?: string;
          acpStatus?: string;
          acpKind?: string;
          acpLocations?: Array<{ path: string; line?: number | null }>;
        }
      );
    }
  }

  private trackPendingFromAgentMessage(sid: string, data: AgentMessage): void {
    if (data.type === 'stream_event') {
      this.trackPendingFromToolUseStreamEvent(sid, data);
    }

    if (data.type !== 'user') {
      return;
    }

    this.clearPendingFromToolResultMessage(sid, data);
  }

  private trackPendingFromToolUseStreamEvent(sid: string, data: AgentMessage): void {
    const streamEvent = (
      data as {
        event?: {
          type?: string;
          content_block?: { type?: string; id?: unknown; name?: unknown; input?: unknown };
        };
      }
    ).event;
    const contentBlock = streamEvent?.content_block;
    const isToolUse =
      streamEvent?.type === 'content_block_start' && contentBlock?.type === 'tool_use';
    if (!isToolUse) {
      return;
    }
    const toolUseId = typeof contentBlock?.id === 'string' ? contentBlock.id : null;
    if (!toolUseId) {
      return;
    }
    const toolName = typeof contentBlock?.name === 'string' ? contentBlock.name : 'ACP Tool';
    const toolInput = this.normalizeToolInput(contentBlock?.input);
    const existing = this.getPendingToolCall(sid, toolUseId);
    this.upsertPendingToolCall(sid, toolUseId, { toolName, toolInput });
    if (!existing) {
      this.notifyInterceptorToolStart(sid, {
        toolUseId,
        toolName,
        toolInput: toolInput ?? {},
      });
    }
  }

  private clearPendingFromToolResultMessage(sid: string, data: AgentMessage): void {
    if (data.type !== 'user') {
      return;
    }
    const content = data.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const item of content) {
      if (item.type === 'tool_result') {
        const pending = this.getPendingToolCall(sid, item.tool_use_id);
        this.notifyInterceptorToolComplete(
          sid,
          item.tool_use_id,
          item.content,
          item.is_error === true,
          pending
        );
        this.removePendingToolCall(sid, item.tool_use_id);
      }
    }
  }

  private trackPendingFromToolProgress(
    sid: string,
    progress: {
      tool_use_id?: string;
      tool_name?: string;
      acpStatus?: string;
      acpKind?: string;
      acpLocations?: Array<{ path: string; line?: number | null }>;
    }
  ): void {
    if (!progress.tool_use_id) {
      return;
    }
    // ACP translator emits terminal tool_progress before tool_result in the same batch.
    // Keep pending metadata here and clear only after processing tool_result.
    const existing = this.getPendingToolCall(sid, progress.tool_use_id);
    this.upsertPendingToolCall(sid, progress.tool_use_id, {
      toolName: progress.tool_name ?? 'ACP Tool',
      acpKind: progress.acpKind,
      acpLocations: progress.acpLocations,
    });
    if (!existing) {
      this.notifyInterceptorToolStart(sid, {
        toolUseId: progress.tool_use_id,
        toolName: progress.tool_name ?? 'ACP Tool',
        toolInput: {},
      });
    }
  }

  private upsertPendingToolCall(
    sid: string,
    toolUseId: string,
    update: Pick<PendingAcpToolCall, 'toolName'> &
      Partial<Pick<PendingAcpToolCall, 'toolInput' | 'acpKind' | 'acpLocations'>>
  ): void {
    const pendingById = this.pendingAcpToolCalls.get(sid) ?? new Map<string, PendingAcpToolCall>();
    const existing = pendingById.get(toolUseId);
    pendingById.set(toolUseId, {
      toolUseId,
      toolName: update.toolName || existing?.toolName || 'ACP Tool',
      toolInput: update.toolInput ?? existing?.toolInput,
      acpKind: update.acpKind ?? existing?.acpKind,
      acpLocations: update.acpLocations ?? existing?.acpLocations,
    });
    this.pendingAcpToolCalls.set(sid, pendingById);
  }

  private getPendingToolCall(sid: string, toolUseId: string): PendingAcpToolCall | undefined {
    return this.pendingAcpToolCalls.get(sid)?.get(toolUseId);
  }

  private removePendingToolCall(sid: string, toolUseId: string): void {
    const pendingById = this.pendingAcpToolCalls.get(sid);
    if (!pendingById) {
      return;
    }
    pendingById.delete(toolUseId);
    if (pendingById.size === 0) {
      this.pendingAcpToolCalls.delete(sid);
    }
  }

  private normalizeToolInput(input: unknown): Record<string, unknown> | undefined {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return undefined;
    }
    return input as Record<string, unknown>;
  }

  private extractToolResultText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .flatMap((item) => {
          if (
            typeof item === 'object' &&
            item !== null &&
            (item as { type?: unknown }).type === 'text' &&
            typeof (item as { text?: unknown }).text === 'string'
          ) {
            return [(item as { text: string }).text];
          }
          return [];
        })
        .join('\n');
    }

    if (content === undefined || content === null) {
      return '';
    }

    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  private getInterceptorContext(sessionId: string): InterceptorContext | null {
    const workspaceId = this.sessionToWorkspace.get(sessionId);
    const workingDir = this.sessionToWorkingDir.get(sessionId);
    if (!(workspaceId && workingDir)) {
      return null;
    }

    return {
      sessionId,
      workspaceId,
      workingDir,
      timestamp: new Date(),
    };
  }

  private notifyInterceptorToolStart(
    sessionId: string,
    tool: Pick<PendingAcpToolCall, 'toolUseId' | 'toolName'> & {
      toolInput: Record<string, unknown>;
    }
  ): void {
    const context = this.getInterceptorContext(sessionId);
    if (!context) {
      return;
    }

    const event: ToolEvent = {
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      input: tool.toolInput,
    };
    interceptorRegistry.notifyToolStart(event, context);
  }

  private notifyInterceptorToolComplete(
    sessionId: string,
    toolUseId: string,
    content: unknown,
    isError: boolean,
    pending: PendingAcpToolCall | undefined
  ): void {
    const context = this.getInterceptorContext(sessionId);
    if (!context) {
      return;
    }

    const event: ToolEvent = {
      toolUseId,
      toolName: pending?.toolName ?? 'ACP Tool',
      input: pending?.toolInput ?? {},
      output: {
        content: this.extractToolResultText(content),
        isError,
      },
    };
    interceptorRegistry.notifyToolComplete(event, context);
  }

  private maybeLiftReplaySuppression(sessionId: string): void {
    if (!this.suppressAcpReplayForSession.has(sessionId)) {
      return;
    }
    if (!this.runtimeManager.isSessionWorking(sessionId)) {
      return;
    }
    this.suppressAcpReplayForSession.delete(sessionId);
  }
}
