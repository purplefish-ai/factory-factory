import type {
  AcpRuntimeEvent,
  AcpSessionUpdateEvent,
} from '@/backend/services/session/service/acp';

/** Current provider state must pass suppression even when transcript history is hydrated. */
export function isReplayExemptSessionUpdate(update: AcpSessionUpdateEvent['update']): boolean {
  return (
    update.sessionUpdate === 'session_info_update' ||
    update.sessionUpdate === 'usage_update' ||
    update.sessionUpdate === 'plan'
  );
}

/** Only omit events whose transcript or tool side effects the owner already suppresses. */
export function isTranscriptReplayEvent(event: AcpRuntimeEvent): boolean {
  if (event.type !== 'acp_session_update') {
    return event.type === 'acp_subagent_tool_update';
  }
  return [
    'user_message_chunk',
    'agent_message_chunk',
    'agent_thought_chunk',
    'tool_call',
    'tool_call_update',
    'compaction_update',
    'compaction_summary_chunk',
    'context_compaction',
  ].includes(event.update.sessionUpdate);
}
