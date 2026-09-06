class BetterCommsMicrophoneEffects extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options.processorOptions;
    this.gain = 10 ** (p.gainDb / 20);
    this.highPassHz = p.highPassHz;
    this.threshold = 10 ** (p.gateThresholdDb / 20);
    this.gateEnabled = p.gateEnabled;
    this.attack = Math.max(1, (p.gateAttackMs * sampleRate) / 1000);
    this.hold = Math.max(0, (p.gateHoldMs * sampleRate) / 1000);
    this.release = Math.max(1, (p.gateReleaseMs * sampleRate) / 1000);
    this.envelope = 0;
    this.gate = p.gateEnabled ? 0 : 1;
    this.holdRemaining = 0;
    this.previousInput = 0;
    this.previousOutput = 0;
    this.hpAlpha =
      this.highPassHz > 0
        ? 1 / (1 + (2 * Math.PI * this.highPassHz) / sampleRate)
        : 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let channel = 0; channel < output.length; channel++) {
      const source = input[Math.min(channel, input.length - 1)];
      const target = output[channel];
      if (!source) {
        target.fill(0);
        continue;
      }
      for (let i = 0; i < target.length; i++) {
        let sample = source[i];
        if (this.highPassHz > 0) {
          const filtered =
            this.hpAlpha * (this.previousOutput + sample - this.previousInput);
          this.previousInput = sample;
          this.previousOutput = filtered;
          sample = filtered;
        }
        this.envelope +=
          (Math.abs(sample) - this.envelope) /
          (Math.abs(sample) > this.envelope ? this.attack : this.release);
        if (this.gateEnabled) {
          if (this.envelope >= this.threshold) this.holdRemaining = this.hold;
          else this.holdRemaining = Math.max(0, this.holdRemaining - 1);
          const open =
            this.envelope >= this.threshold || this.holdRemaining > 0;
          this.gate +=
            ((open ? 1 : 0) - this.gate) / (open ? this.attack : this.release);
        }
        target[i] = sample * this.gain * this.gate;
      }
    }
    return true;
  }
}
registerProcessor(
  'bettercomms-microphone-effects',
  BetterCommsMicrophoneEffects,
);
