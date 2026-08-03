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
export const VoiceAudioChunkMessageSchema = z.object({
  type: z.literal('audio_chunk'),
  data: z.string(),
});

export const VoiceErrorMessageSchema = z.object({
  type: z.literal('voice_error'),
  message: z.string(),
});

/**
 * Tells the browser to immediately drop any playing/queued audio for the
 * current turn. Sent when in-flight thinking narration is cut short by the
 * final answer starting — cancelling Deepgram's synthesis (server-side)
 * stops new audio, but chunks already forwarded to the browser before that
 * happens are already scheduled for local playback and need their own
 * cancellation.
 */
export const VoiceClearPlaybackMessageSchema = z.object({ type: z.literal('clear_playback') });

export const VoiceServerMessageSchema = z.discriminatedUnion('type', [
  VoiceAudioChunkMessageSchema,
  VoiceErrorMessageSchema,
  VoiceClearPlaybackMessageSchema,
]);

export type VoiceAudioChunkMessage = z.infer<typeof VoiceAudioChunkMessageSchema>;
export type VoiceErrorMessage = z.infer<typeof VoiceErrorMessageSchema>;
export type VoiceClearPlaybackMessage = z.infer<typeof VoiceClearPlaybackMessageSchema>;
export type VoiceServerMessage = z.infer<typeof VoiceServerMessageSchema>;
