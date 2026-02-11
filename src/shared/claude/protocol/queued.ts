/**
 * Attachment data for uploaded files in chat.
 */
export interface MessageAttachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  data: string; // base64 for images, raw text for text attachments
  contentType?: 'image' | 'text'; // discriminator for rendering
}

/**
 * A message queued to be sent when the agent becomes idle.
 * This type is shared between frontend and backend.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  settings: {
    selectedModel: string | null;
    thinkingEnabled: boolean;
    planModeEnabled: boolean;
  };
}
