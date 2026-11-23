import type { ChatImageRef } from '@/shared/chat-image-ref';
import type { PRDeliveryRequest } from '@/shared/pr-monitoring';
/**
 * Attachment data for uploaded files in chat.
 */
export interface MessageAttachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  /**
   * Base64 for images, raw text for text attachments. Empty when `ref` is set:
   * the server sends an image it already holds as a reference.
   */
  data: string;
  contentType?: 'image' | 'text'; // discriminator for rendering
  /** Server to client only: the image's bytes are at `chatImageUrl(ref.id)`. */
  ref?: ChatImageRef;
}

/**
 * A message queued to be sent when the agent becomes idle.
 * This type is shared between frontend and backend.
 */
export interface QueuedMessage {
  source?: { type: 'pr_event'; request: PRDeliveryRequest };
  id: string;
  text: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  /** Set when this message was sent via voice mode; the dispatched prompt gets a brevity instruction appended. */
  voiceMode?: boolean;
  settings: {
    selectedModel: string | null;
    reasoningEffort: string | null;
    thinkingEnabled: boolean;
    planModeEnabled: boolean;
  };
}
