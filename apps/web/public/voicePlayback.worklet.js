class BetterCommsVoicePlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.samples = 0;
    this.started = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'reset') {
        this.queue.length = 0;
        this.offset = 0;
        this.samples = 0;
        this.started = false;
        return;
      }
      if (data.type !== 'audio' || !(data.samples instanceof Float32Array)) return;
      // 120 ms at 48 kHz. New audio wins over stale queued speech.
      while (this.samples + data.samples.length > 5760 && this.queue.length) {
        const stale = this.queue.shift();
        this.samples -= stale.length - this.offset;
        this.offset = 0;
      }
      if (data.samples.length <= 5760) {
        this.queue.push(data.samples);
        this.samples += data.samples.length;
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);
    if (!this.started) {
      if (this.samples < 1920) return true;
      this.started = true;
    }
    let written = 0;
    while (written < output.length && this.queue.length) {
      const current = this.queue[0];
      const count = Math.min(output.length - written, current.length - this.offset);
      output.set(current.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      this.samples -= count;
      if (this.offset === current.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    if (written < output.length) this.started = false;
    return true;
  }
}
registerProcessor('bettercomms-voice-playback', BetterCommsVoicePlayback);
