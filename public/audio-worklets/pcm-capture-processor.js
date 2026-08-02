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
  }

  process(inputs) {
    const channelData = inputs[0]?.[0];
    if (!channelData || channelData.length === 0) {
      return true;
    }

    const kept = [];
    for (const rawSample of channelData) {
      this.accumulator += 1;
      if (this.accumulator >= this.ratio) {
        this.accumulator -= this.ratio;
        kept.push(rawSample);
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
