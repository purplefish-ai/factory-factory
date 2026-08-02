/**
 * Downsamples mic input to a target sample rate and converts it to 16-bit
 * PCM frames for Deepgram's streaming STT (encoding=linear16). Runs on the
 * audio rendering thread; posts each frame's buffer to the main thread.
 */
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetSampleRate = options.processorOptions?.targetSampleRate ?? 16_000;
    this.ratio = sampleRate / targetSampleRate;
    this.accumulator = 0;
    // One-pole low-pass filter run over every raw sample before decimation.
    // Dropping samples with no anti-alias filtering lets any input content
    // above the target Nyquist frequency (common on hardware mic rates like
    // 44.1/48kHz) fold back into the audible band post-downsample, which
    // degrades Deepgram transcript accuracy. A single pole has a gentle
    // rolloff rather than a brick-wall cutoff, but it's cheap enough to run
    // per-sample on the audio thread and meaningfully attenuates the
    // aliasing range.
    const cutoffHz = (targetSampleRate / 2) * 0.9;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const dt = 1 / sampleRate;
    this.filterAlpha = dt / (rc + dt);
    this.filterState = 0;
  }

  process(inputs) {
    const channelData = inputs[0]?.[0];
    if (!channelData || channelData.length === 0) {
      return true;
    }

    const kept = [];
    for (const rawSample of channelData) {
      this.filterState += this.filterAlpha * (rawSample - this.filterState);
      this.accumulator += 1;
      if (this.accumulator >= this.ratio) {
        this.accumulator -= this.ratio;
        kept.push(this.filterState);
      }
    }

    if (kept.length > 0) {
      const pcm16 = new Int16Array(kept.length);
      kept.forEach((rawSample, index) => {
        const sample = Math.max(-1, Math.min(1, rawSample));
        pcm16[index] = sample < 0 ? sample * 0x80_00 : sample * 0x7f_ff;
      });
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
