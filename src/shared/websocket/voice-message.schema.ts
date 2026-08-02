/**
 * Zod schemas and types for the /voice WebSocket. Deliberately separate from
 * ChatMessageSchema (chat-message.schema.ts) so voice mode adds zero new
 * variants to the existing chat message protocol.
 */

import { z } from 'zod';

// ============================================================================
// Client -> Server
// ============================================================================

export const VoiceClientMessageSchema = z.discriminatedUnion('type', [
  // Cancel the in-flight turn without tearing down the ACP subprocess (Phase 4).
  z.object({ type: z.literal('soft_stop') }),
]);

export type VoiceClientMessage = z.infer<typeof VoiceClientMessageSchema>;
export type SoftStopMessage = Extract<VoiceClientMessage, { type: 'soft_stop' }>;

// ============================================================================
// Server -> Client
// ============================================================================

/** Base64-encoded linear16 PCM audio chunk synthesized by Deepgram TTS. */
export interface VoiceAudioChunkMessage {
  type: 'audio_chunk';
  data: string;
  seq: number;
}

export interface VoiceErrorMessage {
  type: 'voice_error';
  message: string;
}

export type VoiceServerMessage = VoiceAudioChunkMessage | VoiceErrorMessage;
