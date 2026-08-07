/**
 * Bounds and labeling for voice mode's two "aggressiveness" controls:
 * how long a pause before it decides the user stopped talking (turn-ending),
 * and how quickly it decides the user started talking over the agent's TTS
 * (barge-in). Both are exposed as raw values plus a derived label so the two
 * representations can never disagree.
 */

// Deepgram requires utterance_end_ms >= 1000; upper bound is a UX choice,
// not a Deepgram constraint.
export const VOICE_UTTERANCE_END_MS_MIN = 1000;
export const VOICE_UTTERANCE_END_MS_MAX = 3000;
export const VOICE_UTTERANCE_END_MS_STEP = 250;
export const DEFAULT_VOICE_UTTERANCE_END_MS = 1000;

// 1 frame (8ms, the audio worklet's fixed render-quantum duration — see
// AUDIO_WORKLET_FRAME_MS in use-mic-capture.ts) is the floor; 0 sustained
// frames would trigger on any single loud sample. Past ~80ms (10 frames)
// barge-in starts to feel sluggish.
export const VOICE_BARGE_IN_SUSTAINED_MS_MIN = 8;
export const VOICE_BARGE_IN_SUSTAINED_MS_MAX = 80;
export const VOICE_BARGE_IN_SUSTAINED_MS_STEP = 8;
export const DEFAULT_VOICE_BARGE_IN_SUSTAINED_MS = 16;

export type VoiceAggressivenessLabel = 'Aggressive' | 'Balanced' | 'Patient';

export function deriveAggressivenessLabel(
  value: number,
  min: number,
  max: number
): VoiceAggressivenessLabel {
  const fraction = (value - min) / (max - min);
  if (fraction <= 1 / 3) {
    return 'Aggressive';
  }
  if (fraction <= 2 / 3) {
    return 'Balanced';
  }
  return 'Patient';
}
