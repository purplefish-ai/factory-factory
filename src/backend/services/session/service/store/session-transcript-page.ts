import { ApplicationError } from '@/backend/lib/application-error';
import { type ChatMessage, trimTranscriptForRenderer } from '@/shared/acp-protocol';

/** Cursor identity stays stable when live entries are appended or their order is repaired. */
export function selectTranscriptPage(transcript: ChatMessage[], beforeMessageId: string) {
  const end = transcript.findIndex((message) => message.id === beforeMessageId);
  if (end === -1) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'The transcript history has changed. Reload the conversation to browse earlier messages.'
    );
  }
  const messages = trimTranscriptForRenderer(transcript.slice(0, end), 500);
  return { messages, hasMore: messages.length < end };
}
