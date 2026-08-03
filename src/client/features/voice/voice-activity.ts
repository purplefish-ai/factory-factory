/**
 * Lightweight RMS-energy voice activity detection for barge-in: pausing TTS
 * playback the instant the user starts talking over it. No VAD library is
 * needed at this scope — a moving amplitude threshold over a couple of
 * consecutive frames is enough to avoid triggering on single-sample noise.
 */

const RMS_THRESHOLD = 0.02;
const SUSTAINED_FRAMES_TO_TRIGGER = 2;
/** Must match TARGET_SAMPLE_RATE in use-mic-capture.ts — samples observed here are already decimated to it. */
const SAMPLE_RATE_HZ = 16_000;
/**
 * How long a stretch of below-threshold audio must hold before speech is
 * considered actually over. A single quiet frame can land in an ordinary
 * pause between words while the user is still talking; ending the speaking
 * state right then lets barge-in-suppressed TTS resume over the rest of
 * their speech. Measured in samples (rather than frame count) so it doesn't
 * depend on how many samples the caller happens to batch per `observe` call.
 */
const SILENCE_HANGOVER_SAMPLES = 0.2 * SAMPLE_RATE_HZ;

export function computeRms(samples: Int16Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = sample / 0x80_00;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export class SpeechActivityDetector {
  private loudFrameStreak = 0;
  private quietSampleStreak = 0;
  private speaking = false;

  /** Returns true the instant sustained speech is newly detected in this frame. */
  observe(samples: Int16Array): boolean {
    const rms = computeRms(samples);
    if (rms >= RMS_THRESHOLD) {
      this.loudFrameStreak += 1;
      this.quietSampleStreak = 0;
    } else {
      this.loudFrameStreak = 0;
      this.quietSampleStreak += samples.length;
      if (this.quietSampleStreak >= SILENCE_HANGOVER_SAMPLES) {
        this.speaking = false;
      }
    }
    if (!this.speaking && this.loudFrameStreak >= SUSTAINED_FRAMES_TO_TRIGGER) {
      this.speaking = true;
      return true;
    }
    return false;
  }

  /** Whether the most recent `observe()` call is still within sustained speech. */
  isSpeaking(): boolean {
    return this.speaking;
  }

  reset(): void {
    this.loudFrameStreak = 0;
    this.quietSampleStreak = 0;
    this.speaking = false;
  }
}
