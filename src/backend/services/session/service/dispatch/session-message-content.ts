import { processAttachmentsAndBuildContent } from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import { VOICE_MODE_BREVITY_INSTRUCTION } from '@/backend/services/session/service/voice/voice-mode-instructions';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';

export function buildMessageContent(msg: QueuedMessage): string | AgentContentItem[] {
  const content = processAttachmentsAndBuildContent(msg.text, msg.attachments);
  if (!msg.voiceMode) {
    return content;
  }
  const blocks: AgentContentItem[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return [...blocks, { type: 'text', text: VOICE_MODE_BREVITY_INSTRUCTION }];
}
