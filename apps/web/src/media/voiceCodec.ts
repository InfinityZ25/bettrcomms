const codec = 'opus';
const sampleRate = 48_000;
const frameSamples = 960;

type VoiceEncoder = { dispose(): void; setBitrate(bps: number): void };
type VoiceDecoder = {
  track: MediaStreamTrack;
  stream: MediaStream;
  push(packet: Uint8Array, sequence: number): void;
  dispose(): void;
};

function webCodecs() {
  const api = globalThis as typeof globalThis & Record<string, any>;
  if (!api.AudioEncoder || !api.AudioDecoder || !api.AudioData || !api.EncodedAudioChunk)
    throw new Error('WebCodecs Opus audio is unavailable in this browser');
  return api;
}

function bitrate(value: number) {
  if (!Number.isFinite(value)) throw new Error('Voice bitrate must be finite');
  return Math.max(16_000, Math.min(256_000, Math.round(value)));
}

export async function createVoiceEncoder(
  track: MediaStreamTrack,
  onPacket: (packet: Uint8Array) => void,
  onError: (error: unknown) => void,
): Promise<VoiceEncoder> {
  const api = webCodecs();
  if (track.kind !== 'audio' || track.readyState === 'ended')
    throw new Error('Voice encoder requires a live processed microphone track');
  const audioTrack = track as MediaStreamAudioTrack;
  const config = { codec, sampleRate, numberOfChannels: 1, bitrate: 64_000 };
  const support = await api.AudioEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error('WebCodecs Opus encoding is unsupported');
  const Processor = api.MediaStreamTrackProcessor;
  if (!Processor) throw new Error('MediaStreamTrackProcessor is unavailable');
  let disposed = false;
  let timestamp = 0;
  let pending = new Float32Array(0);
  let activeBitrate = config.bitrate;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let derivedTrack: MediaStreamTrack | undefined;
  let encoder: any;
  let reader: any;
  let silenceTimer: number | undefined;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    track.removeEventListener('ended', cleanup);
    if (silenceTimer !== undefined) clearInterval(silenceTimer);
    void reader?.cancel().catch(() => undefined);
    try { if (encoder?.state !== 'closed') encoder?.close(); } catch { /* already failed */ }
    derivedTrack?.stop();
    source?.disconnect(); destination?.disconnect();
    if (context) void context.close().catch(() => undefined);
  };
  try {
    // The graph normalizes browser/device rates to the Opus clock without ever
    // connecting to the local speaker. Only the derived track is owned here.
    context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    if (context.sampleRate !== sampleRate) throw new Error('48 kHz voice encoding is unavailable');
    source = context.createMediaStreamSource(new MediaStream([audioTrack]));
    destination = context.createMediaStreamDestination();
    source.connect(destination);
    derivedTrack = destination.stream.getAudioTracks()[0];
    if (!derivedTrack) throw new Error('Voice encoder could not create normalized audio');
    encoder = new api.AudioEncoder({
      output(chunk: any) {
        if (disposed) return;
        const packet = new Uint8Array(chunk.byteLength);
        chunk.copyTo(packet);
        onPacket(packet);
      },
      error(error: unknown) { if (!disposed) { onError(error); cleanup(); } },
    });
    encoder.configure(config);
    const processor = new Processor({ track: derivedTrack as MediaStreamAudioTrack });
    reader = processor.readable.getReader();
    track.addEventListener('ended', cleanup, { once: true });
    silenceTimer = window.setInterval(() => {
      if (disposed || (track.enabled && !track.muted) || encoder.encodeQueueSize > 3) return;
      pending = new Float32Array(0);
      const frame = new Float32Array(frameSamples);
      const audio = new api.AudioData({
        format: 'f32-planar', sampleRate, numberOfFrames: frameSamples,
        numberOfChannels: 1, timestamp, data: frame,
      });
      timestamp += 20_000;
      encoder.encode(audio);
      audio.close();
    }, 20);
    await context.resume();
  } catch (error) {
    cleanup();
    throw error;
  }
  const pump = async () => {
    try {
      while (!disposed) {
        const { value: data, done } = await reader.read();
        if (done) break;
        try {
          if (data.sampleRate !== sampleRate || data.numberOfChannels < 1)
            throw new Error('Voice encoder input must be 48 kHz audio');
          if (encoder.encodeQueueSize > 3) continue;
          const incoming = new Float32Array(data.numberOfFrames);
          data.copyTo(incoming, { planeIndex: 0, format: 'f32-planar' });
          if (!track.enabled || track.muted) {
            pending = new Float32Array(0);
            continue;
          }
          const combined = new Float32Array(Math.min(5760, pending.length + incoming.length));
          const keepPending = Math.min(pending.length, Math.max(0, combined.length - incoming.length));
          combined.set(pending.subarray(pending.length - keepPending), 0);
          combined.set(incoming.subarray(Math.max(0, incoming.length - (combined.length - keepPending))), keepPending);
          pending = combined;
          let offset = 0;
          for (; offset + frameSamples <= pending.length; offset += frameSamples) {
            if (encoder.encodeQueueSize > 3) break;
            const frame = pending.slice(offset, offset + frameSamples);
            const audio = new api.AudioData({
              format: 'f32-planar', sampleRate, numberOfFrames: frameSamples,
              numberOfChannels: 1, timestamp, data: frame,
            });
            timestamp += 20_000;
            encoder.encode(audio);
            audio.close();
          }
          pending = pending.slice(offset);
        } finally { data.close(); }
      }
    } catch (error) {
      if (!disposed) onError(error);
    } finally { cleanup(); }
  };
  void pump();
  return {
    dispose() {
      cleanup();
    },
    setBitrate(bps: number) {
      const next = bitrate(bps);
      if (disposed || next === activeBitrate) return;
      activeBitrate = next;
      encoder.configure({ ...config, bitrate: next });
    },
  };
}

export async function createVoiceDecoder(
  onError: (error: unknown) => void,
): Promise<VoiceDecoder> {
  const api = webCodecs();
  const config = { codec, sampleRate, numberOfChannels: 1 };
  const support = await api.AudioDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error('WebCodecs Opus decoding is unsupported');
  const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
  let node: AudioWorkletNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let track: MediaStreamTrack | undefined;
  let disposed = false;
  let expectedSequence: number | undefined;
  let lastPacketAt = 0;
  let decoder: any;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    try { if (decoder?.state !== 'closed') decoder?.close(); } catch { /* codec already failed */ }
    node?.port.postMessage({ type: 'reset' });
    node?.disconnect(); node?.port.close();
    track?.stop(); destination?.disconnect();
    void context.close().catch(() => undefined);
  };
  decoder = new api.AudioDecoder({
    output(data: any) {
      try {
        if (disposed || !node) return;
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
        node.port.postMessage({ type: 'audio', samples }, [samples.buffer]);
      } finally { data.close(); }
    },
    error(error: unknown) { if (!disposed) { onError(error); cleanup(); } },
  });
  try {
    if (context.sampleRate !== sampleRate) throw new Error('48 kHz voice playback is unavailable');
    await context.audioWorklet.addModule('/voicePlayback.worklet.js');
    node = new AudioWorkletNode(context, 'bettercomms-voice-playback', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    });
    destination = context.createMediaStreamDestination();
    node.connect(destination);
    decoder.configure(config);
    await context.resume();
    const stream = destination.stream;
    track = stream.getAudioTracks()[0];
    if (!track) throw new Error('Voice decoder could not create an output track');
    return {
      track, stream,
      push(packet: Uint8Array, sequence: number) {
        if (disposed || !packet.byteLength || !Number.isSafeInteger(sequence)) return;
        const now = performance.now();
        if (expectedSequence !== undefined && (sequence !== expectedSequence || now - lastPacketAt > 250)) {
          decoder.reset();
          decoder.configure(config);
          node!.port.postMessage({ type: 'reset' });
        }
        expectedSequence = sequence + 1;
        lastPacketAt = now;
        if (decoder.decodeQueueSize > 4) return;
        decoder.decode(new api.EncodedAudioChunk({
          type: 'key', timestamp: sequence * 20_000, data: packet,
        }));
      },
      dispose() {
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    await context.close().catch(() => undefined);
    throw error;
  }
}
