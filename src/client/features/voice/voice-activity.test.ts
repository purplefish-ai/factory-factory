import { describe, expect, it } from 'vitest';
import { computeRms, SpeechActivityDetector } from './voice-activity';

function silence(length = 160): Int16Array {
  return new Int16Array(length);
}

function loudTone(length = 160, amplitude = 0.5): Int16Array {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = Math.round(amplitude * 0x7f_ff * Math.sin(i / 4));
  }
  return samples;
}

describe('computeRms', () => {
  it('returns 0 for silence', () => {
    expect(computeRms(silence())).toBe(0);
  });

  it('returns 0 for an empty buffer', () => {
    expect(computeRms(new Int16Array(0))).toBe(0);
  });

  it('returns a positive value proportional to amplitude', () => {
    const quiet = computeRms(loudTone(160, 0.1));
    const loud = computeRms(loudTone(160, 0.8));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
  });
});

describe('SpeechActivityDetector', () => {
  it('does not trigger on silence', () => {
    const detector = new SpeechActivityDetector();
    expect(detector.observe(silence())).toBe(false);
    expect(detector.observe(silence())).toBe(false);
  });

  it('does not trigger on a single loud frame (debounces noise spikes)', () => {
    const detector = new SpeechActivityDetector();
    expect(detector.observe(loudTone())).toBe(false);
  });

  it('triggers once after sustained loud frames, then stays quiet until silence resets it', () => {
    const detector = new SpeechActivityDetector();
    expect(detector.observe(loudTone())).toBe(false);
    expect(detector.observe(loudTone())).toBe(true);
    // Already flagged as speaking — no repeated trigger while still loud.
    expect(detector.observe(loudTone())).toBe(false);

    expect(detector.observe(silence())).toBe(false);

    // A fresh burst of speech after silence triggers again.
    expect(detector.observe(loudTone())).toBe(false);
    expect(detector.observe(loudTone())).toBe(true);
  });
});
