class BettercommsNvidiaProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSamples = options.processorOptions.frameSamples;
    this.inputFrame = new Float32Array(this.frameSamples);
    this.inputOffset = 0;
    this.nextId = 0;
    this.expectedProcessedId = 0;
    this.outstanding = 0;
    this.processed = [];
    this.outputOffset = 0;
    this.started = false;
    this.waitingSamples = 0;
    this.renderedSamples = 0;
    this.failed = false;
    // Millisecond budgets are independent of the SDK's 10/20 ms frame size.
    this.targetFrames = Math.max(
      1,
      Math.ceil((sampleRate * 0.04) / this.frameSamples),
    );
    this.recoveryFrames = Math.max(
      1,
      Math.ceil((sampleRate * 0.08) / this.frameSamples),
    );
    this.maxInFlight = Math.min(
      24,
      Math.max(1, Math.ceil((sampleRate * 0.24) / this.frameSamples)),
    );
    this.recoveries = [];
    this.underruns = 0;
    this.droppedFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (this.failed) return;
      if (data && data.type === 'processed') {
        if (
          data.id !== this.expectedProcessedId ||
          this.outstanding <= 0 ||
          !(data.samples instanceof ArrayBuffer) ||
          data.samples.byteLength !== this.frameSamples * 4 ||
          new Float32Array(data.samples).some(
            (value) => !Number.isFinite(value),
          )
        ) {
          this.fail('NVIDIA returned an invalid or out-of-order audio frame');
          return;
        }
        this.expectedProcessedId++;
        this.outstanding--;
        this.processed.push(new Float32Array(data.samples));
        // Late results must never turn into an ever-growing playback delay.
        // Prefer recent processed audio after a scheduling stall.
        if (this.processed.length > this.targetFrames + 2) {
          const discarded = this.processed.length - this.targetFrames;
          this.processed.splice(0, discarded);
          this.outputOffset = 0;
          this.droppedFrames += discarded;
          this.report();
        }
      }
    };
  }

  report() {
    this.port.postMessage({
      type: 'playout',
      underruns: this.underruns,
      droppedFrames: this.droppedFrames,
      bufferMs: (this.targetFrames * this.frameSamples * 1000) / sampleRate,
    });
  }

  fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.processed.length = 0;
    this.port.postMessage({ type: 'failure', reason });
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    if (this.failed) {
      output.fill(0);
      return true;
    }
    if (!this.started && this.processed.length >= this.targetFrames) {
      this.started = true;
      this.waitingSamples = 0;
    }
    for (let i = 0; i < output.length; i++) {
      this.renderedSamples++;
      this.inputFrame[this.inputOffset++] = input ? input[i] || 0 : 0;
      if (this.started && !this.processed.length) {
        this.started = false;
        this.targetFrames = this.recoveryFrames;
        this.underruns++;
        this.recoveries = this.recoveries.filter(
          (at) => this.renderedSamples - at < sampleRate * 10,
        );
        this.recoveries.push(this.renderedSamples);
        this.report();
        if (this.recoveries.length > 3)
          this.fail(
            'NVIDIA audio repeatedly stalled (4 buffer recoveries within 10 seconds)',
          );
      }
      const ready = !this.failed && this.started && this.processed[0];
      output[i] = ready ? ready[this.outputOffset++] : 0;
      if (!ready && !this.failed) {
        this.waitingSamples++;
        if (this.waitingSamples >= sampleRate * 0.25)
          this.fail('NVIDIA audio did not recover within 250 ms');
      }
      if (ready && this.outputOffset === ready.length) {
        this.processed.shift();
        this.outputOffset = 0;
      }
      if (this.inputOffset === this.frameSamples) {
        if (!this.failed) {
          if (this.outstanding >= this.maxInFlight) {
            this.fail('NVIDIA audio input queue exceeded its 240 ms limit');
          } else {
            this.outstanding++;
            const samples = this.inputFrame.buffer;
            this.inputFrame = new Float32Array(this.frameSamples);
            this.port.postMessage(
              { type: 'frame', id: this.nextId++, samples },
              [samples],
            );
          }
        }
        this.inputOffset = 0;
      }
    }
    return true;
  }
}

registerProcessor('bettercomms-nvidia-denoiser', BettercommsNvidiaProcessor);
