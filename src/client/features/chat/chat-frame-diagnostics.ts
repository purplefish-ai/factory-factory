import { toast } from 'sonner';
import { z } from 'zod';
import type { WebSocketMessage } from '@/lib/chat-protocol';
import { logProtocolError } from '@/lib/debug';
import {
  type DroppedChatElement,
  parseChatServerMessage,
} from '@/shared/acp-protocol/protocol/chat-server-message-schema';

const FrameTypeSchema = z.object({ type: z.string() });
const INVALID_FRAME_TOAST_ID = 'chat-invalid-frame';

function frameType(data: unknown): string {
  const frame = FrameTypeSchema.safeParse(data);
  return frame.success ? frame.data.type : 'unknown';
}

function notify(): void {
  // One toast id, so a burst of bad frames does not stack notifications.
  toast.error("Some chat updates couldn't be read and were skipped.", {
    id: INVALID_FRAME_TOAST_ID,
    description: 'Reload if the conversation looks out of date. Details are in the console.',
  });
}

/** A frame that failed validation is dropped rather than applied. */
function reportInvalidChatFrame(data: unknown, error: z.ZodError): void {
  logProtocolError('[chat] Dropped an invalid WebSocket frame', {
    type: frameType(data),
    issues: z.prettifyError(error),
  });
  notify();
}

/** Replay chunks that are malformed, oversized or reassemble into an invalid batch. */
export function reportInvalidReplayFrame(error: unknown): void {
  logProtocolError('[chat] Dropped an invalid replay frame', {
    issues: error instanceof z.ZodError ? z.prettifyError(error) : String(error),
  });
  notify();
}

/** Replay events removed from an otherwise valid replay batch. */
function reportDroppedChatElements(type: string, dropped: DroppedChatElement[]): void {
  logProtocolError('[chat] Dropped invalid elements from a WebSocket frame', {
    type,
    dropped: dropped.map(({ path, issues }) => ({
      path: path.join('.'),
      issues: z.prettifyError(new z.ZodError(issues)),
    })),
  });
  notify();
}

/**
 * Validate one reassembled server frame; null means the replay assembler is
 * still collecting chunks. Invalid frames and dropped replay events are
 * reported; the caller receives only valid data.
 */
export function readChatFrame(frame: unknown): WebSocketMessage | null {
  if (frame === null) {
    return null;
  }
  const parsed = parseChatServerMessage(frame);
  if (!parsed.success) {
    reportInvalidChatFrame(frame, parsed.error);
    return null;
  }
  if (parsed.dropped.length > 0) {
    reportDroppedChatElements(parsed.message.type, parsed.dropped);
  }
  return parsed.message;
}
