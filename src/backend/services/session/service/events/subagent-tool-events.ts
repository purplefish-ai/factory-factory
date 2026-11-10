import type { ToolEvent } from '@/backend/interceptors/types';
import { createLogger } from '@/backend/services/logger.service';
import {
  AcpEventTranslator,
  type AcpSubagentToolUpdateEvent,
} from '@/backend/services/session/service/acp';

const logger = createLogger('subagent-tool-events');

const MAX_PENDING_TOOL_CALLS = 1000;

type PendingSubagentToolCall = {
  sessionId: string;
  metaToolName?: string;
  title?: string;
  input: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function claudeToolName(meta: unknown): string | undefined {
  const toolName = isRecord(meta) && isRecord(meta.claudeCode) ? meta.claudeCode.toolName : null;
  return typeof toolName === 'string' && toolName ? toolName : undefined;
}

function toolResult(
  deltas: ReturnType<AcpEventTranslator['translateSessionUpdate']>
): { content: string; isError: boolean } | null {
  for (const delta of deltas) {
    if (delta.type !== 'agent_message' || delta.data.type !== 'user') {
      continue;
    }
    const content = delta.data.message?.content;
    const result = Array.isArray(content)
      ? content.find((item) => item.type === 'tool_result')
      : undefined;
    if (result?.type === 'tool_result') {
      return {
        content:
          typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        isError: result.is_error === true,
      };
    }
  }
  return null;
}

/**
 * Collects a native sub-agent's streamed tool updates into completed tool events.
 * Sub-agent output never enters the parent transcript, so this keeps its own
 * terminal-output buffers and does not start parent tool timeouts.
 */
export class SubagentToolEventCollector {
  private readonly translator = new AcpEventTranslator(logger);
  private readonly pending = new Map<string, PendingSubagentToolCall>();
  private readonly childKeysBySession = new Map<string, Set<string>>();

  collect(
    sessionId: string,
    event: Pick<AcpSubagentToolUpdateEvent, 'subagentId' | 'update'>
  ): ToolEvent | null {
    const { subagentId, update } = event;
    const childKey = JSON.stringify([sessionId, subagentId]);
    const key = JSON.stringify([childKey, update.toolCallId]);
    const childKeys = this.childKeysBySession.get(sessionId) ?? new Set<string>();
    childKeys.add(childKey);
    this.childKeysBySession.set(sessionId, childKeys);

    const entry = this.pending.get(key) ?? { sessionId, input: {} };
    entry.metaToolName = claudeToolName(update._meta) ?? entry.metaToolName;
    entry.title = update.title || entry.title;
    // Claude publishes the command in a later update than the tool call itself.
    if (isRecord(update.rawInput) && Object.keys(update.rawInput).length > 0) {
      entry.input = update.rawInput;
    }
    this.pending.delete(key);
    this.pending.set(key, entry);
    if (this.pending.size > MAX_PENDING_TOOL_CALLS) {
      const oldest = this.pending.keys().next().value;
      if (oldest) {
        this.pending.delete(oldest);
      }
    }

    const output = toolResult(this.translator.translateSessionUpdate(update, childKey));
    if (!output) {
      return null;
    }
    this.pending.delete(key);
    return {
      toolUseId: update.toolCallId,
      toolName: entry.metaToolName ?? entry.title ?? 'ACP Tool',
      input: entry.input,
      output,
    };
  }

  clearSession(sessionId: string): void {
    for (const childKey of this.childKeysBySession.get(sessionId) ?? []) {
      this.translator.clearTerminalOutput(childKey);
    }
    this.childKeysBySession.delete(sessionId);
    for (const [key, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        this.pending.delete(key);
      }
    }
  }
}
