import type { MediaSignal, SignalingAdapter } from "./types";

export type RoomSocketEventMap = {
  peers: CustomEvent<{ peerIds: string[]; identities: Record<string, { userId: string; name?: string }> }>;
  signal: CustomEvent<MediaSignal>;
  "peer-joined": CustomEvent<{ peerId: string; userId?: string; name?: string }>;
  "peer-left": CustomEvent<{ peerId: string; userId?: string; name?: string }>;
  presence: CustomEvent<{ peerId: string; payload: unknown }>;
  latency: CustomEvent<{ rttMs: number | null }>;
  error: CustomEvent<unknown>;
  close: Event;
};

/** Adapter for the Bettercomms room WebSocket protocol. */
export class RoomWebSocketSignaling extends EventTarget implements SignalingAdapter {
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private pingInterval?: number;
  private pingTimeout?: number;
  private pendingPing?: { nonce: string; sentAt: number };

  readonly url: string;

  constructor(readonly localPeerId: string, url: string) {
    super();
    this.url = toWebSocketUrl(url);
  }

  addEventListener<K extends keyof RoomSocketEventMap>(
    type: K,
    listener: (this: RoomWebSocketSignaling, event: RoomSocketEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void { super.addEventListener(type, listener, options); }

  connect(timeoutMs = 10_000): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      let opened = false;
      const timeout = window.setTimeout(() => {
        if (opened) return;
        socket.close(4000, "connection timeout");
        reject(new Error(`Room WebSocket did not connect within ${timeoutMs}ms`));
      }, timeoutMs);
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        opened = true;
        window.clearTimeout(timeout);
        this.opening = undefined;
        this.startTelemetry(socket);
        resolve();
      };
      socket.onerror = (event) => {
        if (this.socket !== socket) return;
        this.stopTelemetry(true);
        this.dispatchEvent(new CustomEvent("error", { detail: event }));
        if (socket.readyState !== WebSocket.OPEN) { this.opening = undefined; reject(new Error("Room WebSocket failed to connect")); }
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        window.clearTimeout(timeout);
        this.stopTelemetry(true);
        this.socket = undefined;
        this.opening = undefined;
        if (!opened) reject(new Error(`Room WebSocket closed before connecting (${event.code})`));
        this.dispatchEvent(new Event("close"));
        if (!event.wasClean) this.dispatchEvent(new CustomEvent("error", { detail: event }));
      };
      socket.onmessage = (event) => {
        if (this.socket === socket) this.receive(event.data);
      };
    });
    return this.opening;
  }

  async send(signal: MediaSignal): Promise<void> {
    await this.connect();
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Room WebSocket is not open");
    this.socket.send(JSON.stringify(signal));
  }

  sendPresence(payload: { camera: boolean; microphone: boolean; sharing: boolean; recording?: boolean; muted?: boolean; deafened?: boolean; name?: string }): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Room WebSocket is not open");
    this.socket.send(JSON.stringify({ type: "presence", payload }));
  }

  close(code = 1000, reason = "media session ended"): void {
    const socket = this.socket;
    this.stopTelemetry(true);
    this.opening = undefined;
    if (socket) socket.close(code, reason);
    else this.socket = undefined;
  }

  private receive(raw: unknown): void {
    try {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      const type = message.type;
      if (type === "pong") {
        const nonce = message.request_id;
        if (typeof nonce === "string" && nonce === this.pendingPing?.nonce) {
          const rttMs = Math.max(0, performance.now() - this.pendingPing.sentAt);
          this.clearPingTimeout();
          this.pendingPing = undefined;
          this.dispatchEvent(new CustomEvent("latency", { detail: { rttMs } }));
        }
      } else if (type === "peers") {
        const payload = message.payload as { peers?: unknown; identities?: unknown } | undefined;
        const peerIds = Array.isArray(payload?.peers) ? payload.peers.map(String) : [];
        const identities = payload?.identities && typeof payload.identities === 'object'
          ? Object.fromEntries(Object.entries(payload.identities).map(([peerId, identity]) => {
              const value = identity as { user_id?: unknown; name?: unknown };
              return [peerId, { userId: String(value?.user_id ?? ''), name: typeof value?.name === 'string' ? value.name : undefined }];
            }))
          : {};
        this.dispatchEvent(new CustomEvent("peers", { detail: { peerIds, identities } }));
      } else if (type === "peer.joined" || type === "peer.left") {
        this.dispatchEvent(new CustomEvent(type === "peer.joined" ? "peer-joined" : "peer-left", { detail: {
          peerId: String(message.from),
          userId: typeof message.user_id === 'string' ? message.user_id : undefined,
          name: typeof message.name === 'string' ? message.name : undefined,
        } }));
      } else if (type === "presence") {
        this.dispatchEvent(new CustomEvent("presence", { detail: { peerId: String(message.from), payload: message.payload } }));
      } else if (type === "offer" || type === "answer" || type === "ice-candidate" || type === "track-metadata" || (type === "signal" && (message.transport === "native-screen" || message.transport === "voice-relay"))) {
        this.dispatchEvent(new CustomEvent("signal", { detail: message as unknown as MediaSignal }));
      } else if (type === "error") {
        this.dispatchEvent(new CustomEvent("error", { detail: message.error }));
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
    }
  }

  private startTelemetry(socket: WebSocket): void {
    this.stopTelemetry(false);
    const ping = () => this.sendPing(socket);
    ping();
    this.pingInterval = window.setInterval(ping, 5_000);
  }

  private sendPing(socket: WebSocket): void {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.pendingPing) return;
    const nonce = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.pendingPing = { nonce, sentAt: performance.now() };
    socket.send(JSON.stringify({ type: "ping", request_id: nonce }));
    this.pingTimeout = window.setTimeout(() => {
      if (this.socket !== socket || this.pendingPing?.nonce !== nonce) return;
      this.pendingPing = undefined;
      this.pingTimeout = undefined;
      this.dispatchEvent(new CustomEvent("latency", { detail: { rttMs: null } }));
    }, 10_000);
  }

  private clearPingTimeout(): void {
    if (this.pingTimeout !== undefined) window.clearTimeout(this.pingTimeout);
    this.pingTimeout = undefined;
  }

  private stopTelemetry(markUnavailable: boolean): void {
    const wasActive = this.pingInterval !== undefined || this.pendingPing !== undefined;
    if (this.pingInterval !== undefined) window.clearInterval(this.pingInterval);
    this.pingInterval = undefined;
    this.clearPingTimeout();
    this.pendingPing = undefined;
    if (markUnavailable && wasActive) {
      this.dispatchEvent(new CustomEvent("latency", { detail: { rttMs: null } }));
    }
  }
}

function toWebSocketUrl(value: string): string {
  const url = new URL(value, window.location.href);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new TypeError("Signaling URL must use http(s) or ws(s)");
  return url.href;
}
