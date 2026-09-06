export interface AudioLevelerOptions {
  targetRms?: number;
  minGain?: number;
  maxGain?: number;
  smoothing?: number;
  intervalMs?: number;
}

/** Lightweight local playback leveling. It does not alter the transmitted track. */
export class AudioLeveler {
  private readonly context: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly gain: GainNode;
  private timer?: number;
  private readonly samples: Float32Array<ArrayBuffer>;
  private volume = 1;

  constructor(stream: MediaStream, destination: AudioNode, options: AudioLevelerOptions = {}) {
    this.context = destination.context as AudioContext;
    this.source = this.context.createMediaStreamSource(stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.samples = new Float32Array(this.analyser.fftSize);
    this.gain = this.context.createGain();
    this.source.connect(this.analyser).connect(this.gain).connect(destination);

    const target = options.targetRms ?? 0.12;
    const min = options.minGain ?? 0.5;
    const max = options.maxGain ?? 2;
    const smoothing = options.smoothing ?? 0.12;
    this.timer = window.setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.samples);
      const rms = Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length);
      if (rms < 0.002) return;
      const desired = this.volume * Math.min(max, Math.max(min, target / rms));
      this.gain.gain.setTargetAtTime(
        this.gain.gain.value + (desired - this.gain.gain.value) * smoothing,
        this.context.currentTime,
        0.05,
      );
    }, options.intervalMs ?? 100);
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, volume);
  }

  dispose(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.source.disconnect();
    this.analyser.disconnect();
    this.gain.disconnect();
  }
}
