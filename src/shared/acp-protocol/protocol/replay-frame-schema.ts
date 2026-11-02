import { z } from 'zod';

export const MAX_REPLAY_FRAME_BYTES = 128 * 1024;
export const MAX_REPLAY_BYTES = 128 * 1024 * 1024;
export const REPLAY_CHUNK_BYTES = 96 * 1024 - 1024;
const BaseFrameSchema = z.object({
  type: z.literal('session_replay_chunk'),
  replayId: z.string().min(1).max(64),
  /** Correlate even a byte-fragmented envelope before its contents are decoded. */
  loadRequestId: z.string().max(128).optional(),
  index: z.number().int().nonnegative(),
  total: z
    .number()
    .int()
    .positive()
    .max(4 * Math.ceil(MAX_REPLAY_BYTES / MAX_REPLAY_FRAME_BYTES) + 1),
  byteLength: z.number().int().positive().max(MAX_REPLAY_BYTES),
});
const Base64Schema = z
  .string()
  .min(1)
  .max(Math.ceil(REPLAY_CHUNK_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const SessionReplayBatchSchema = z
  .object({
    type: z.literal('session_replay_batch'),
    loadRequestId: z.string().optional(),
    replayEvents: z.array(z.unknown()).optional(),
  })
  .passthrough();
const EventBatchSchema = SessionReplayBatchSchema.extend({ replayEvents: z.array(z.unknown()) });
export const SessionReplayChunkSchema = z.discriminatedUnion('encoding', [
  BaseFrameSchema.extend({
    encoding: z.undefined().optional(),
    chunk: Base64Schema,
    replayEvents: z.never().optional(),
    batch: z.never().optional(),
    eventByteLength: z.never().optional(),
  }).strict(),
  BaseFrameSchema.extend({
    encoding: z.literal('events'),
    chunk: z.never().optional(),
    eventByteLength: z.never().optional(),
    replayEvents: z.array(z.unknown()),
    batch: EventBatchSchema.optional(),
  }).strict(),
  BaseFrameSchema.extend({
    encoding: z.literal('event_fragment'),
    replayEvents: z.never().optional(),
    batch: z.never().optional(),
    chunk: Base64Schema,
    eventByteLength: z.number().int().positive().max(MAX_REPLAY_BYTES),
  }).strict(),
]);

export type SessionReplayChunk = z.infer<typeof SessionReplayChunkSchema>;
export type SessionReplayEnvelope = z.infer<typeof BaseFrameSchema>;
