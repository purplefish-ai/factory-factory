/**
 * Lightweight RMS-energy voice activity detection for barge-in: pausing TTS
 * playback the instant the user starts talking over it. No VAD library is
 * needed at this scope — a moving amplitude threshold over a couple of
 * consecutive frames is enough to avoid triggering on single-sample noise.
 */

const RMS_THRESHOLD = 0.02;
const SUSTAINED_FRAMES_TO_TRIGGER = 2;

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
  private speaking = false;

  /** Returns true the instant sustained speech is newly detected in this frame. */
  observe(samples: Int16Array): boolean {
    const rms = computeRms(samples);
    if (rms >= RMS_THRESHOLD) {
      this.loudFrameStreak += 1;
    } else {
      this.loudFrameStreak = 0;
      this.speaking = false;
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
    this.speaking = false;
  }
}
