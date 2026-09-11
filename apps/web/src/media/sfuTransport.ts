/**
 * SFU transport: one `RTCPeerConnection` between this client and the
 * Bettrcomms SFU (apps/sfu), instead of one per remote participant like
 * `engine.ts`'s mesh `MediaEngine`. Room roster, presence, and chat stay on
 * the existing Railway signaling `Hub` unchanged — this only carries the
 * media negotiation for whichever room the caller is publishing/subscribing
 * to a given call in.
 *
 * This is a first, working slice of Phase 8's `MediaTransport` abstraction:
 * connect, publish local tracks, receive forwarded remote tracks, clean
 * teardown. It intentionally does NOT yet replicate every
 * `MediaEngine` feature (recording epochs, per-source quality controls,
 * native screen picker integration, `getStats` parity) — those stay on the
 * mesh path for now. See docs/MEDIA_ARCHITECTURE.md for what's covered.
 *
 * Known gap: forwarded tracks arrive via the SFU's own re-offers and are
 * not yet correlated back to a `MediaSourceKind` (camera vs screen vs mic
 * vs system audio) the way mesh's `track-metadata` signal does — `ontrack`
 * fires with only what WebRTC itself exposes (audio/video + the mid). Fixing
 * that needs either verifying the SFU preserves publisher msids through
 * forwarding, or a side-channel over the existing room WS; flagged as
 * follow-up rather than guessed at.
 */

export type SfuConnectionState = RTCPeerConnectionState;

export type SfuTransportEventMap = {
  'remote-track': CustomEvent<{ track: MediaStreamTrack; streams: readonly MediaStream[] }>;
  'connection-state': CustomEvent<{ state: SfuConnectionState }>;
  error: CustomEvent<{ operation: string; error: unknown }>;
};

interface SfuJoinResponse {
  sfu_url: string;
  token: string;
  ttl_seconds: number;
}

type RequestId = number;

type ServerMessage =
  | { type: 'sdp'; request_id: RequestId; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; request_id: RequestId; candidate: RTCIceCandidateInit }
  | { type: 'error'; request_id: RequestId; reason: string };

/**
 * Fetches a short-lived join token from the Railway API for `roomId` and
 * returns where to connect. Throws on any non-2xx response, including 503
 * when no SFU is configured for this deployment (caller should fall back
 * to the mesh/P2P transport in that case).
 */
export async function requestSfuJoin(roomId: string): Promise<SfuJoinResponse> {
  const response = await fetch(`/api/v1/rooms/${roomId}/sfu-join`, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`sfu-join failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<SfuJoinResponse>;
}

export class SfuTransport extends EventTarget {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection;
  private nextRequestId = 1;
  private closed = false;

  constructor(private readonly iceServers: RTCIceServer[] = []) {
    super();
    this.pc = this.createPeerConnection();
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    pc.onicecandidate = (event) => {
      if (event.candidate) this.send({ type: 'ice', request_id: this.nextRequestId++, candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      this.dispatchEvent(
        new CustomEvent('remote-track', { detail: { track: event.track, streams: event.streams } }),
      );
    };
    pc.onconnectionstatechange = () => {
      this.dispatchEvent(new CustomEvent('connection-state', { detail: { state: pc.connectionState } }));
    };
    // The SFU renegotiates (server-initiated offers) whenever it forwards a
    // new publisher's track to us; this fires for our own local publish
    // calls too via addTransceiver, so one handler covers both.
    pc.onnegotiationneeded = () => {
      // Only the client side ever *initiates* a fresh negotiation from this
      // event (publishing a track); server-initiated re-offers arrive as
      // inbound `sdp` messages instead and are handled in handleServerMessage.
      if (pc.signalingState !== 'stable') return;
      void this.negotiate();
    };
    return pc;
  }

  /** Opens the signaling WebSocket to the SFU and completes the bootstrap negotiation. */
  async connect(roomId: string): Promise<void> {
    const join = await requestSfuJoin(roomId);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${join.sfu_url}?token=${encodeURIComponent(join.token)}`);
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('sfu websocket failed to open')), { once: true });
      ws.addEventListener('message', (event) => this.handleServerMessage(event));
      ws.addEventListener('close', () => {
        if (!this.closed) this.dispatchEvent(new CustomEvent('connection-state', { detail: { state: 'closed' } }));
      });
      this.ws = ws;
    });
    // A pure subscriber (no local tracks yet) still has to complete one
    // SDP round before the SFU will forward anything to it — a data
    // channel is enough to produce a valid offer either way.
    this.pc.createDataChannel('bootstrap');
    await this.negotiate();
  }

  /** Adds a local track for the SFU to forward to other subscribers. */
  publish(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    return this.pc.addTrack(track, stream);
  }

  unpublish(sender: RTCRtpSender): void {
    this.pc.removeTrack(sender);
  }

  private async negotiate(): Promise<void> {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.send({ type: 'sdp', request_id: this.nextRequestId++, sdp: offer });
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: { operation: 'negotiate', error } }));
    }
  }

  private async handleServerMessage(event: MessageEvent<string>): Promise<void> {
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: { operation: 'parse-message', error } }));
      return;
    }
    try {
      switch (message.type) {
        case 'sdp':
          await this.handleRemoteSdp(message.sdp);
          break;
        case 'ice':
          await this.pc.addIceCandidate(message.candidate);
          break;
        case 'error':
          this.dispatchEvent(new CustomEvent('error', { detail: { operation: 'sfu', error: message.reason } }));
          break;
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: { operation: `handle-${message.type}`, error } }));
    }
  }

  private async handleRemoteSdp(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (sdp.type === 'offer') {
      // Server-initiated re-offer: a new publisher's track is being
      // forwarded to us, or one stopped being forwarded.
      await this.pc.setRemoteDescription(sdp);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.send({ type: 'sdp', request_id: this.nextRequestId++, sdp: answer });
    } else {
      // Answer to an offer we sent (initial bootstrap or a publish call).
      await this.pc.setRemoteDescription(sdp);
    }
  }

  private send(message: { type: 'sdp'; request_id: RequestId; sdp: RTCSessionDescriptionInit } | { type: 'ice'; request_id: RequestId; candidate: RTCIceCandidateInit }): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.pc.close();
  }
}
