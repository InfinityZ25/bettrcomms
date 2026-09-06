// The render clock requests PCM; no throttled window timers or local playback.
class SystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(48000);
    this.read = 0;
    this.size = 0;
    this.frames = 960;
    this.playing = false;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'stop') {
        this.stopped = true;
        return;
      }
      if (data.type !== 'audio' || !(data.samples instanceof Float32Array))
        return;
      const samples = data.samples;
      // After a renderer stall, retain at most 100ms instead of replaying stale audio.
      if (this.size + samples.length > 9600) {
        this.read = 0;
        this.size = 0;
        this.playing = false;
      }
      const offset = Math.max(0, samples.length - 9600);
      for (let i = offset; i < samples.length; i++) {
        this.ring[(this.read + this.size) % this.ring.length] = Number.isFinite(
          samples[i],
        )
          ? Math.max(-1, Math.min(1, samples[i]))
          : 0;
        this.size++;
      }
    };
  }
  process(_inputs, outputs) {
    if (this.stopped) return false;
    const output = outputs[0];
    const length = output[0]?.length ?? 128;
    this.frames += length;
    if (this.frames >= 960) {
      this.frames %= 960;
      this.port.postMessage({ type: 'read' });
    }
    if (!this.playing && this.size >= 3840) this.playing = true;
    for (let frame = 0; frame < length; frame++) {
      if (this.playing && this.size >= 2) {
        output[0][frame] = this.ring[this.read];
        output[1][frame] = this.ring[(this.read + 1) % this.ring.length];
        this.read = (this.read + 2) % this.ring.length;
        this.size -= 2;
      } else {
        output[0][frame] = 0;
        output[1][frame] = 0;
        this.playing = false;
      }
    }
    return true;
  }
}
registerProcessor('bettercomms-system-audio', SystemAudioProcessor);
