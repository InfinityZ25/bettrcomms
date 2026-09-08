import type { MediaSignal, SignalingAdapter } from "./types";

export type RoomSocketEventMap = {
  peers: CustomEvent<{ peerIds: string[]; identities: Record<string, { userId: string; name?: string }> }>;
  signal: CustomEvent<MediaSignal>;
  "peer-joined": CustomEvent<{ peerId: string; userId?: string; name?: string }>;
  "peer-left": CustomEvent<{ peerId: string; userId?: string; name?: string }>;
  presence: CustomEvent<{ peerId: string; payload: unknown }>;
  latency: CustomEvent<{ rttMs: number | null }>;
  error: CustomEvent<unknown>;
  /** Signaling is temporarily unavailable. Established media is unaffected. */
  disconnected: CustomEvent<{ attempt: number; delayMs: number }>;
  /** Signaling is usable again. Presence must be re-announced. */
  reconnected: Event;
  /** The session is over: the caller closed it, or reconnection gave up. */
  close: Event;
};

/**
 * Signaling carries offers, candidates, presence and membership. Once a peer
 * connection is established its media flows directly between peers and needs
 * none of that, so a server restart must not end a call. Retry for roughly a
 * minute and a half before treating the session as genuinely over.
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const RECONNECT_ATTEMPTS = 12;

/**
 * Only transport-level failures may be retried. The server ends a session
 * deliberately with a policy violation — a connection replaced from another
 * device, revoked membership, a deleted room, a revoked session — and
 * reconnecting through any of those would defeat the decision. Anything not
 * listed here, including a normal closure, ends the session.
 */
const RECONNECTABLE_CLOSE_CODES = new Set([
  1001, // going away: the server is shutting down for a deploy
  1005, // no status received
  1006, // abnormal closure: the connection died
  1011, // internal error
  1012, // service restart
  1013, // try again later
  1014, // bad gateway
]);

/** Adapter for the Bettercomms room WebSocket protocol. */
export class RoomWebSocketSignaling extends EventTarget implements SignalingAdapter {
  private socket?: WebSocket;
  private opening?: Promise<void>;
  private pingInterval?: number;
  private pingTimeout?: number;
  private pendingPing?: { nonce: string; sentAt: number };
  private closing = false;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: number;

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
      // A resume must only reclaim its own peer identity. Reusing the original
      // join mode would let an automatic reconnection evict this account's
      // other devices, which only a deliberate join is allowed to do.
      const socket = new WebSocket(this.reconnecting ? this.resumeUrl() : this.url);
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
        const resumed = this.reconnecting;
        this.reconnecting = false;
        this.reconnectAttempt = 0;
        // A queued signal can reconnect before the backoff timer fires.
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.startTelemetry(socket);
        resolve();
        if (resumed) this.dispatchEvent(new Event("reconnected"));
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
        if (!opened) {
          reject(new Error(`Room WebSocket closed before connecting (${event.code})`));
          // A retry that never opened is handled by the retry loop itself;
          // a first attempt that never opened means the join failed.
          if (!this.reconnecting) this.dispatchEvent(new Event("close"));
          return;
        }
        if (this.closing || !RECONNECTABLE_CLOSE_CODES.has(event.code)) {
          this.dispatchEvent(new Event("close"));
          if (!this.closing && !event.wasClean)
            this.dispatchEvent(new CustomEvent("error", { detail: event }));
          return;
        }
        if (!event.wasClean) this.dispatchEvent(new CustomEvent("error", { detail: event }));
        // Established peer connections keep carrying media without signaling,
        // so losing this socket is a degraded state rather than a finished call.
        this.reconnecting = true;
        this.scheduleReconnect();
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

  private resumeUrl(): string {
    try {
      const url = new URL(this.url);
      url.searchParams.set("join_mode", "additional");
      return url.toString();
    } catch {
      return this.url;
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.reconnectAttempt >= RECONNECT_ATTEMPTS) {
      this.reconnecting = false;
      this.dispatchEvent(new Event("close"));
      return;
    }
    const attempt = ++this.reconnectAttempt;
    const delayMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
    this.dispatchEvent(new CustomEvent("disconnected", { detail: { attempt, delayMs } }));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closing) return;
      this.connect().catch(() => this.scheduleReconnect());
    }, delayMs);
  }

  close(code = 1000, reason = "media session ended"): void {
    const socket = this.socket;
    this.closing = true;
    this.reconnecting = false;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopTelemetry(true);
    this.opening = undefined;
    // A caller that closes during the retry backoff has no socket to close and
    // tears its own session down; emitting "close" here would race that.
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
