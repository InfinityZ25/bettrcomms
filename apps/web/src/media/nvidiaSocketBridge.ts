type AudioFrame = { type: 'frame'; id: number; samples: ArrayBuffer };
type Socket = Pick<WebSocket, 'send' | 'readyState' | 'bufferedAmount'>;

/** Owned by a dedicated Worker, never by the UI thread. */
export class NvidiaSocketBridge {
  private active = true;
  private current: AudioFrame | undefined;
  private queue: AudioFrame[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 0;
  processedFrames = 0;
  constructor(
    private socket: Socket,
    private port: Pick<MessagePort, 'postMessage'>,
    private frameSamples: number,
    private onFailure: (reason: string) => void,
    private displayName = 'NVIDIA',
  ) {}
  submit(frame: AudioFrame) {
    if (!this.active) return;
    if (
      frame.id !== this.nextId ||
      !(frame.samples instanceof ArrayBuffer) ||
      frame.samples.byteLength !== this.frameSamples * 4
    ) {
      this.fail(`${this.displayName} audio input frame is invalid`);
      return;
    }
    this.nextId++;
    if (this.current) {
      // Match the worklet's bounded 240 ms recovery allowance. A single native
      // request remains serialized and has its own 250 ms timeout.
      if (
        this.queue.length >=
        Math.min(24, Math.ceil((48_000 * 0.24) / this.frameSamples)) - 1
      )
        this.fail(`${this.displayName} audio processing could not keep up`);
      else this.queue.push(frame);
      return;
    }
    this.send(frame);
  }
  private send(frame: AudioFrame) {
    if (
      this.socket.readyState !== 1 ||
      this.socket.bufferedAmount > this.frameSamples * 4
    ) {
      this.fail(`${this.displayName} audio connection is unavailable`);
      return;
    }
    this.current = frame;
    this.timer = setTimeout(
      () => this.fail(`${this.displayName} audio processing timed out`),
      250,
    );
    try {
      this.socket.send(frame.samples);
    } catch {
      this.fail(`${this.displayName} audio connection failed`);
    }
  }
  receive(samples: ArrayBuffer) {
    if (!this.active) return;
    if (
      !this.current ||
      !(samples instanceof ArrayBuffer) ||
      samples.byteLength !== this.frameSamples * 4 ||
      new Float32Array(samples).some((value) => !Number.isFinite(value))
    ) {
      this.fail(`${this.displayName} returned an invalid audio frame`);
      return;
    }
    clearTimeout(this.timer);
    const id = this.current.id;
    this.current = undefined;
    this.processedFrames++;
    this.port.postMessage({ type: 'processed', id, samples }, [samples]);
    const next = this.queue.shift();
    if (next) this.send(next);
  }
  fail(reason: string) {
    if (!this.active) return;
    this.dispose();
    this.onFailure(reason);
  }
  dispose() {
    this.active = false;
    clearTimeout(this.timer);
    this.current = undefined;
    this.queue.length = 0;
  }
}
