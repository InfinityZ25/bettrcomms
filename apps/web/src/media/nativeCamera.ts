import { NativeScreenTransport } from './nativeScreen';
import { callIOSMetaSender } from '../desktop/iosNativeBindings';
import type { MediaSignal, SignalingAdapter } from './types';

/** Separate camera transport: never shares screen capture IDs, tracks, or stops. */
export class NativeCameraTransport {
  private transport: NativeScreenTransport;
  constructor(signaling: SignalingAdapter, iceServers: RTCIceServer[], directOnly: boolean,
    onRemote: (peerId: string, track: MediaStreamTrack) => void,
    onRemoved: (peerId: string) => void, onError: (reason: string) => void) {
    this.transport = new NativeScreenTransport({
      localPeerId: signaling.localPeerId,
      send: (signal) => signaling.send({ ...signal, transport: 'native-camera' } as MediaSignal),
    }, iceServers, directOnly, () => {}, onRemote, onRemoved, onError,
    async () => { onError('The native camera connection could not sustain video.'); }, {
      invoke: callIOSMetaSender,
      externalPreview: true,
      disableFallback: true,
      listen: async (_listener) => {
        const handler = (event: Event) => {
          const detail = (event as CustomEvent<{kind: string; message?: string}>).detail;
          if (detail?.kind === 'error') onError(detail.message ?? 'Glasses camera stopped.');
          if (detail?.kind === 'stopped') void this.stop();
        };
        window.addEventListener('bc-meta-camera', handler);
        return () => window.removeEventListener('bc-meta-camera', handler);
      },
    });
  }
  get active() { return this.transport.active; }
  async start(peerIds: string[]) {
    await this.transport.start({ sourceId: 'meta-camera', encoder: 'libx264', width: 720,
      height: 1280, fps: 30, bitrateMbps: 3, cursor: false, h264Profile: 'baseline', contentHint: 'motion' }, peerIds);
    await Promise.all(peerIds.map(id => this.transport.addPeer(id)));
  }
  handle(signal: MediaSignal) { return this.transport.handle({ ...signal, transport: 'native-screen' } as MediaSignal); }
  addPeer(id: string) { return this.transport.addPeer(id); }
  removePeer(id: string) { return this.transport.removePeer(id); }
  stop() { return this.transport.stop(); }
  dispose() { this.transport.dispose(); }
  getDiagnostics() { return this.transport.getDiagnostics(); }
}
