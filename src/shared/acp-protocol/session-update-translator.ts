import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { z } from 'zod';
import type { SessionDeltaEvent } from './protocol';
import type { SubagentTranscriptUpdate } from './subagents';

export type AcpTranslationLogger = {
  warn(message: string, details?: unknown): void;
};

type ContextCompactionUpdate = {
  sessionUpdate: 'context_compaction';
  [key: string]: unknown;
};

// Compatibility shim until ACP SDK adds `context_compaction` to SessionUpdate.
export type TranslatableSessionUpdate =
  | SessionUpdate
  | SubagentTranscriptUpdate
  | ContextCompactionUpdate;

export type AcpTranslatedDelta = SessionDeltaEvent & Record<string, unknown>;

const sessionNoticeSchema = z.object({
  _meta: z.object({
    jetbrains: z.object({
      air: z.object({
        sessionFailure: z.object({
          id: z.string().min(1),
          revision: z.number().int().nonnegative(),
          severity: z.literal('warning'),
          title: z.string().trim().min(1),
          details: z.string().optional(),
        }),
      }),
    }),
  }),
});

const MAX_TERMINAL_OUTPUT_CHARS = 256 * 1024;
const MAX_BUFFERED_TERMINAL_TOOLS = 64;
const MAX_TERMINALS_PER_TOOL = 16;
const terminalOutputSchema = z.object({ data: z.string(), terminal_id: z.string().min(1) });
const terminalReferenceSchema = z.object({
  type: z.literal('terminal'),
  terminalId: z.string().min(1),
});
type TerminalOutputState = { sessionId: string; text: string; terminalIds: Set<string> };

/**
 * Maps ACP SessionUpdate variants to FF deltas, retaining bounded pending terminal output.
 *
 * Modeled on CodexEventTranslator. Each ACP session update type is mapped to the
 * appropriate FF delta event type(s) that the frontend already knows how to render.
 *
 * Error handling: Never throws. Malformed or missing data produces a warning log
 * and returns an empty array, so one bad event does not break the pipeline.
 */
export class AcpEventTranslator {
  private readonly sessionNotices = new Map<string, Set<string>>();
  private readonly terminalOutput = new Map<string, TerminalOutputState>();
  // Retain replay identities until clearTerminalOutput tears down their session.
  private readonly compactions = new Map<string, { sessionId: string; status: string }>();

  constructor(private readonly logger: AcpTranslationLogger) {}

  translateSessionUpdate(update: TranslatableSessionUpdate, sessionId = ''): SessionDeltaEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.translateAgentMessageChunk(update);

      case 'agent_thought_chunk':
        return this.translateAgentThoughtChunk(update);

      case 'tool_call':
        this.captureTerminalOutput(update, sessionId, true);
        return this.translateToolCall(update, sessionId);

      case 'tool_call_update':
        this.captureTerminalOutput(update, sessionId);
        return this.translateToolCallUpdate(update, sessionId);

      case 'plan':
        return this.translatePlan(update);

      case 'available_commands_update':
        return this.translateAvailableCommands(update);

      case 'usage_update':
        return this.translateUsageUpdate(update);

      case 'config_option_update':
        return this.translateConfigOptionUpdate(update);

      case 'compaction_update':
        return this.translateCompactionUpdate(update, sessionId);

      case 'compaction_summary_chunk':
        // Retained model context is intentionally represented by the concise boundary.
        return this.translateCompactionUpdate({ ...update, status: 'in_progress' }, sessionId);

      case 'context_compaction':
        return this.translateContextCompactionUpdate(update);

      case 'session_info_update':
        return this.translateSessionNotice(update, sessionId);

      // Not yet translated -- log-only
      case 'current_mode_update':
      case 'user_message_chunk':
        return [];

      default:
        this.logger.warn('Unknown ACP session update type', {
          sessionUpdate: this.readSessionUpdateType(update),
        });
        return [];
    }
  }

  clearTerminalOutput(sessionId: string): void {
    this.sessionNotices.delete(sessionId);
    for (const [key, state] of this.compactions) {
      if (state.sessionId === sessionId) {
        this.compactions.delete(key);
      }
    }
    for (const [key, output] of this.terminalOutput) {
      if (output.sessionId === sessionId) {
        this.terminalOutput.delete(key);
      }
    }
  }

  private translateSessionNotice(update: unknown, sessionId: string): AcpTranslatedDelta[] {
    const parsed = sessionNoticeSchema.safeParse(update);
    if (!parsed.success) {
      return [];
    }
    const notice = parsed.data._meta.jetbrains.air.sessionFailure;
    const key = JSON.stringify([notice.id, notice.revision]);
    const seen = this.sessionNotices.get(sessionId) ?? new Set<string>();
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    this.sessionNotices.set(sessionId, seen);
    const text = `Warning: ${notice.title}${notice.details ? `\n\n${notice.details}` : ''}\n\n`;
    return this.translateAgentMessageChunk({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  }

  private captureTerminalOutput(
    update: { toolCallId: string; _meta?: unknown; content?: unknown },
    sessionId: string,
    reset = false
  ): void {
    const key = JSON.stringify([sessionId, update.toolCallId]);
    if (reset) {
      this.terminalOutput.delete(key);
    }
    const state = this.terminalOutput.get(key) ?? {
      sessionId,
      text: '',
      terminalIds: new Set<string>(),
    };
    let changed = this.registerTerminalReferences(state, update.content);
    const meta = this.getObject(update._meta);
    const parsed = terminalOutputSchema.safeParse(
      meta?.terminal_output_delta ?? meta?.terminal_output
    );
    if (
      parsed.success &&
      (parsed.data.terminal_id === update.toolCallId ||
        state.terminalIds.has(parsed.data.terminal_id))
    ) {
      const previous = meta?.terminal_output_delta != null ? state.text : '';
      state.text = `${previous}${parsed.data.data.slice(-MAX_TERMINAL_OUTPUT_CHARS)}`;
      // Trim with hysteresis so small deltas do not copy the whole retained tail every time.
      if (state.text.length > 2 * MAX_TERMINAL_OUTPUT_CHARS) {
        state.text = state.text.slice(-MAX_TERMINAL_OUTPUT_CHARS);
      }
      changed = true;
    }
    if (!changed) {
      return;
    }
    this.terminalOutput.delete(key);
    this.terminalOutput.set(key, state);
    if (this.terminalOutput.size > MAX_BUFFERED_TERMINAL_TOOLS) {
      const oldest = this.terminalOutput.keys().next().value;
      if (oldest !== undefined) {
        this.terminalOutput.delete(oldest);
      }
    }
  }

  private registerTerminalReferences(state: TerminalOutputState, content: unknown): boolean {
    if (!Array.isArray(content)) {
      return false;
    }
    const count = state.terminalIds.size;
    for (const item of content) {
      if (state.terminalIds.size >= MAX_TERMINALS_PER_TOOL) {
        break;
      }
      const parsed = terminalReferenceSchema.safeParse(item);
      if (parsed.success) {
        state.terminalIds.add(parsed.data.terminalId);
      }
    }
    return state.terminalIds.size !== count;
  }

  private translateAgentMessageChunk(
    update: Extract<TranslatableSessionUpdate, { sessionUpdate: 'agent_message_chunk' }>
  ): AcpTranslatedDelta[] {
    const text = this.extractTextChunkContent(update, 'agent_message_chunk');
    if (text === null) {
      return [];
    }

    return [
      {
        type: 'agent_message',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
        },
      },
    ];
  }

  private translateAgentThoughtChunk(
    update: Extract<TranslatableSessionUpdate, { sessionUpdate: 'agent_thought_chunk' }>
  ): AcpTranslatedDelta[] {
    const text = this.extractTextChunkContent(update, 'agent_thought_chunk');
    if (text === null) {
      return [];
    }

    return [
      {
        type: 'agent_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: text },
          },
        },
      },
    ];
  }

  private translateToolCall(
    update: Extract<TranslatableSessionUpdate, { sessionUpdate: 'tool_call' }>,
    sessionId: string
  ): AcpTranslatedDelta[] {
    if (!(update.toolCallId && update.title)) {
      this.logger.warn('tool_call: missing toolCallId or title', {
        toolCallId: update.toolCallId,
        title: update.title,
      });
      return [];
    }

    // Prefer _meta.claudeCode.toolName (the actual tool name) over title
    // (display label that may be generic like "Terminal" or a formatted command string).
    const meta = (update as Record<string, unknown>)._meta as
      | { claudeCode?: { toolName?: string } }
      | undefined;
    const toolName = meta?.claudeCode?.toolName ?? update.title;

    const events: AcpTranslatedDelta[] = [];
    events.push({
      type: 'agent_message',
      data: {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: update.toolCallId,
            name: toolName,
            input: (update.rawInput as Record<string, unknown>) ?? {},
          },
        },
      },
    });

    const toolProgress: Record<string, unknown> = {
      type: 'tool_progress',
      tool_use_id: update.toolCallId,
      tool_name: toolName,
      acpLocations: update.locations ?? [],
      acpKind: update.kind ?? undefined,
      acpStatus: update.status ?? undefined,
    };
    if (this.isTerminalToolStatus(update.status)) {
      toolProgress.elapsed_time_seconds = 0;
    }
    events.push(toolProgress as AcpTranslatedDelta);

    // Some adapters emit one-shot terminal tool_call events without a follow-up tool_call_update.
    // Emit tool_result here so UI tool cards don't remain stuck in pending state.
    this.appendTerminalToolResultIfNeeded(events, update, sessionId);

    return events;
  }

  private translateToolCallUpdate(
    update: Extract<TranslatableSessionUpdate, { sessionUpdate: 'tool_call_update' }>,
    sessionId: string
  ): AcpTranslatedDelta[] {
    if (!update.toolCallId) {
      this.logger.warn('tool_call_update: missing toolCallId', { update });
      return [];
    }

    const event: Record<string, unknown> = {
      type: 'tool_progress',
      tool_use_id: update.toolCallId,
      tool_name: update.title ?? undefined,
      acpStatus: update.status ?? undefined,
      acpKind: update.kind ?? undefined,
      acpLocations: update.locations ?? [],
      acpContent: update.content ?? undefined,
    };

    // Signal completion to existing tool progress tracking
    if (this.isTerminalToolStatus(update.status)) {
      event.elapsed_time_seconds = 0;
    }

    const events: AcpTranslatedDelta[] = [event as AcpTranslatedDelta];

    // Emit tool_result so the frontend can pair it with the tool_use (transitions pending → success/error)
    this.appendTerminalToolResultIfNeeded(events, update, sessionId);

    return events;
  }

  private translatePlan(
    update: Extract<TranslatableSessionUpdate, { sessionUpdate: 'plan' }>
  ): AcpTranslatedDelta[] {
    return [
      {
        type: 'task_notification',
        message: JSON.stringify({
          type: 'acp_plan',
          entries: update.entries ?? [],
        }),
      },
    ];
  }

  private translateAvailableCommands(
    update: Extract<SessionUpdate, { sessionUpdate: 'available_commands_update' }>
  ): AcpTranslatedDelta[] {
    const slashCommands = (update.availableCommands ?? []).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      argumentHint: cmd.input?.hint,
    }));

    return [
      {
        type: 'slash_commands',
        slashCommands,
      },
    ];
  }

  private extractToolOutputText(
    content: unknown,
    rawOutput: unknown,
    terminalOutput: string
  ): string {
    const contentText = this.extractContentText(content);
    if (contentText.length > 0) {
      return contentText;
    }
    return terminalOutput || this.extractContentText(rawOutput);
  }

  private createTerminalToolResultEvent(params: {
    toolCallId: string;
    status?: unknown;
    content?: unknown;
    rawOutput?: unknown;
    terminalOutput: string;
  }): AcpTranslatedDelta | null {
    if (!this.isTerminalToolStatus(params.status)) {
      return null;
    }

    return {
      type: 'agent_message',
      data: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: params.toolCallId,
              content: this.extractToolOutputText(
                params.content,
                params.rawOutput,
                params.terminalOutput
              ),
              ...(params.status === 'failed' ? { is_error: true } : {}),
            },
          ],
        },
      },
    };
  }

  private appendTerminalToolResultIfNeeded(
    events: AcpTranslatedDelta[],
    update: {
      toolCallId: string;
      status?: unknown;
      content?: unknown;
      rawOutput?: unknown;
    },
    sessionId: string
  ): void {
    const key = JSON.stringify([sessionId, update.toolCallId]);
    const terminalResult = this.createTerminalToolResultEvent({
      ...update,
      terminalOutput: this.terminalOutput.get(key)?.text.slice(-MAX_TERMINAL_OUTPUT_CHARS) ?? '',
    });
    if (terminalResult) {
      this.terminalOutput.delete(key);
      events.push(terminalResult);
    }
  }

  private extractTextChunkContent(
    update: { content?: { type?: string; text?: string } | null },
    updateType: 'agent_message_chunk' | 'agent_thought_chunk'
  ): string | null {
    if (!update.content) {
      this.logger.warn(`${updateType}: missing content`, { update });
      return null;
    }

    if (update.content.type !== 'text' || typeof update.content.text !== 'string') {
      this.logger.warn(`${updateType}: non-text content type, skipping`, {
        contentType: update.content.type,
      });
      return null;
    }

    return update.content.text;
  }

  private extractContentText(content: unknown): string {
    if (!content) {
      return '';
    }
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((entry) => {
          if (!entry || typeof entry !== 'object') {
            return '';
          }
          const block = entry as { type?: unknown; text?: unknown; content?: unknown };
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
          if (block.type === 'content') {
            return this.extractContentText(block.content);
          }
          return '';
        })
        .filter((text) => text.length > 0)
        .join('\n');
    }
    if (typeof content === 'object') {
      const block = content as { type?: unknown; text?: unknown; content?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
      if (block.type === 'content') {
        return this.extractContentText(block.content);
      }
    }
    return JSON.stringify(content);
  }

  private isTerminalToolStatus(status: unknown): status is 'completed' | 'failed' {
    return status === 'completed' || status === 'failed';
  }

  private translateConfigOptionUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>
  ): AcpTranslatedDelta[] {
    const configOptions = (update as { configOptions?: unknown[] }).configOptions;
    if (!Array.isArray(configOptions)) {
      this.logger.warn('config_option_update: missing configOptions array', { update });
      return [];
    }

    return [
      {
        type: 'config_options_update',
        configOptions,
      } as AcpTranslatedDelta,
    ];
  }

  private translateUsageUpdate(
    update: Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>
  ): AcpTranslatedDelta[] {
    return [
      {
        type: 'agent_message',
        data: {
          type: 'result',
          result: update,
        },
      },
    ];
  }

  private translateCompactionUpdate(
    update: { compactionId: string; status: string; error?: string | null },
    sessionId: string
  ): AcpTranslatedDelta[] {
    const { compactionId, status } = update;
    if (!(compactionId && ['in_progress', 'completed', 'failed', 'cancelled'].includes(status))) {
      this.logger.warn('compaction_update: unknown ID or status', { compactionId, status });
      return [];
    }
    const key = JSON.stringify([sessionId, compactionId]);
    const previous = this.compactions.get(key);
    // Terminal updates can be repeated to enrich metadata or summaries, not create boundaries.
    if (previous && (previous.status !== 'in_progress' || previous.status === status)) {
      return [];
    }
    this.compactions.set(key, { sessionId, status });
    if (status === 'in_progress') {
      return [{ type: 'compacting_start' }];
    }
    const events: AcpTranslatedDelta[] = [{ type: 'compacting_end' }];
    if (status === 'completed') {
      events.push({ type: 'compact_boundary' });
    } else {
      events.push(...this.translateCompactionFailure(status, update.error));
    }
    return events;
  }

  private translateCompactionFailure(status: string, error?: string | null): AcpTranslatedDelta[] {
    const details = typeof error === 'string' ? error.trim() : undefined;
    const text =
      status === 'cancelled'
        ? 'Context compaction cancelled.'
        : `Context compaction failed.${details ? ` ${details}` : ''}`;
    // Claude carries failures here and suppresses its duplicate local-command stdout.
    return this.translateAgentMessageChunk({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
  }

  private translateContextCompactionUpdate(update: ContextCompactionUpdate): AcpTranslatedDelta[] {
    const active = this.extractContextCompactionActiveState(update);
    if (active === null) {
      this.logger.warn('context_compaction: unknown payload shape', { update });
      return [];
    }

    return [{ type: active ? 'compacting_start' : 'compacting_end' }];
  }

  private extractContextCompactionActiveState(update: Record<string, unknown>): boolean | null {
    const nested =
      this.getObject(update.context_compaction) ??
      this.getObject(update.contextCompaction) ??
      this.getObject(update.payload);

    const candidates = [update, ...(nested ? [nested] : [])];
    for (const candidate of candidates) {
      const fromBoolean = this.readCompactionBoolean(candidate);
      if (fromBoolean !== null) {
        return fromBoolean;
      }
    }

    for (const candidate of candidates) {
      const fromString = this.readCompactionStringState(candidate);
      if (fromString !== null) {
        return fromString;
      }
    }

    return null;
  }

  private readCompactionBoolean(source: Record<string, unknown>): boolean | null {
    const booleanFields = ['isCompacting', 'compacting', 'active', 'inProgress', 'in_progress'];
    for (const field of booleanFields) {
      const value = source[field];
      if (typeof value === 'boolean') {
        return value;
      }
    }
    return null;
  }

  private readCompactionStringState(source: Record<string, unknown>): boolean | null {
    const stringFields = ['state', 'status', 'phase', 'event', 'action'];
    for (const field of stringFields) {
      const raw = source[field];
      if (typeof raw !== 'string') {
        continue;
      }
      const normalized = raw.trim().toLowerCase();
      if (
        normalized === 'start' ||
        normalized === 'started' ||
        normalized === 'starting' ||
        normalized === 'begin' ||
        normalized === 'began' ||
        normalized === 'in_progress' ||
        normalized === 'running' ||
        normalized === 'active' ||
        normalized === 'compacting'
      ) {
        return true;
      }
      if (
        normalized === 'end' ||
        normalized === 'ended' ||
        normalized === 'ending' ||
        normalized === 'finish' ||
        normalized === 'finished' ||
        normalized === 'done' ||
        normalized === 'completed' ||
        normalized === 'inactive' ||
        normalized === 'idle' ||
        normalized === 'stopped'
      ) {
        return false;
      }
    }
    return null;
  }

  private getObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private readSessionUpdateType(update: { sessionUpdate?: unknown }): string {
    if (typeof update.sessionUpdate === 'string') {
      return update.sessionUpdate;
    }
    return 'unknown';
  }
}
