export type CopilotMode = 'ping' | 'snapshot';
export type CopilotGrant = { token: string; generation: string; ping: boolean; snapshot: boolean };
export type CopilotMark = {
  id: string; peerId: string; kind: CopilotMode; x: number; y: number;
  image?: string; frozenMs?: number; expires: number; laser?: boolean;
};
type Peer = { channel: RTCDataChannel; ready: boolean; lastMark: number; grant?: CopilotGrant; seen: Set<string>; receivedAt: number; receivedCount: number };
type Snapshot = {
  sharing: boolean; ready: string[]; grants: Record<string, CopilotGrant>;
  offers: Record<string, CopilotGrant>; marks: CopilotMark[]; status: string;
};
const MAX_MESSAGE = 48_000;
export const MAX_IMAGE = 40_000;
const empty = (): Snapshot => ({ sharing: false, ready: [], grants: {}, offers: {}, marks: [], status: '' });
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value);
const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export function isCopilotImage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_IMAGE || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const bytes = atob(value.slice('data:image/jpeg;base64,'.length));
    if (bytes.charCodeAt(0) !== 255 || bytes.charCodeAt(1) !== 216) return false;
    // Check SOF dimensions before asking a browser decoder to allocate an image.
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes.charCodeAt(offset) !== 255) return false;
      const marker = bytes.charCodeAt(offset + 1);
      if (marker === 218 || marker === 217) return false;
      const length = bytes.charCodeAt(offset + 2) * 256 + bytes.charCodeAt(offset + 3);
      if (length < 2 || offset + 2 + length > bytes.length) return false;
      if ([192, 193, 194].includes(marker)) {
        const height = bytes.charCodeAt(offset + 5) * 256 + bytes.charCodeAt(offset + 6);
        const width = bytes.charCodeAt(offset + 7) * 256 + bytes.charCodeAt(offset + 8);
        return height > 0 && height <= 640 && width > 0 && width <= 640;
      }
      offset += length + 2;
    }
  } catch { /* Reject malformed base64 or JPEG. */ }
  return false;
}

/** Device-bound, ephemeral collaboration over the call's DTLS/SCTP channel. */
export class VisualCopilot {
  private peers = new Map<string, Peer>();
  private listeners = new Set<() => void>();
  private state = empty();
  private source: MediaStreamTrack | null = null;
  private generation = '';
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, { peerId: string; timer: ReturnType<typeof setTimeout> }>();
  private disposed = false;
  constructor() { if (typeof window !== 'undefined') { window.addEventListener('bc-visual-copilot', this.settingsChanged); window.addEventListener('storage', this.settingsChanged); } }
  private settingsChanged = () => {
    const settings = readCopilotSettings();
    if (!settings.enabled) { this.pause(); return; }
    for (const [peerId, peer] of this.peers) if (peer.grant && ((!settings.showPings && peer.grant.ping) || (!settings.showCards && peer.grant.snapshot))) {
      this.grant(peerId, settings.showPings && peer.grant.ping, settings.showCards && peer.grant.snapshot);
    }
  };
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<Snapshot>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private refresh() {
    this.update({ sharing: !!this.source, ready: [...this.peers].filter(([, p]) => p.ready).map(([peerId]) => peerId),
      grants: Object.fromEntries([...this.peers].filter(([, p]) => p.grant).map(([peerId, p]) => [peerId, p.grant!])) });
  }
  attach(peerId: string, pc: RTCPeerConnection) {
    if (this.disposed || this.peers.has(peerId)) return;
    // Negotiated ID is reserved for this protocol. Older peers never send hello.
    let channel: RTCDataChannel;
    try { channel = pc.createDataChannel('bettercomms.visual-copilot.v1', { negotiated: true, id: 13, ordered: true }); }
    catch { this.update({ status: 'Visual collaboration is unavailable on this connection. The call can continue.' }); return; }
    const peer: Peer = { channel, ready: false, lastMark: -Infinity, seen: new Set(), receivedAt: performance.now(), receivedCount: 0 };
    this.peers.set(peerId, peer);
    channel.onopen = () => { this.send(peerId, { type: 'hello' }); };
    channel.onmessage = event => { this.receive(peerId, event.data); };
    channel.onerror = channel.onclose = () => this.detach(peerId);
  }
  detach(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    peer.channel.onopen = peer.channel.onclose = peer.channel.onerror = peer.channel.onmessage = null;
    peer.channel.close();
    const offers = { ...this.state.offers }; delete offers[peerId];
    for (const mark of this.state.marks.filter(m => m.peerId === peerId)) this.dismiss(mark.id);
    for (const [key, pending] of this.pending) if (pending.peerId === peerId) { clearTimeout(pending.timer); this.pending.delete(key); }
    this.update({ offers, status: 'Participant disconnected.' }); this.refresh();
  }
  setSource(track: MediaStreamTrack | null) {
    if (this.source === track || this.disposed) return;
    this.source?.removeEventListener('ended', this.sourceEnded);
    this.source = track;
    track?.addEventListener('ended', this.sourceEnded, { once: true });
    this.generation = track ? crypto.randomUUID() : '';
    this.pause(); this.refresh();
  }
  private sourceEnded = () => this.setSource(null);
  getSource() { return this.source; }
  grant(peerId: string, ping: boolean, snapshot: boolean) {
    const preferences = readCopilotSettings();
    ping = ping && preferences.enabled && preferences.showPings;
    snapshot = snapshot && preferences.enabled && preferences.showCards;
    const peer = this.peers.get(peerId);
    if (!peer || !peer.ready) return;
    if (!this.source || this.source.readyState !== 'live' || (!ping && !snapshot)) {
      peer.grant = undefined; this.send(peerId, { type: 'revoke' });
    } else {
      peer.grant = { token: crypto.randomUUID(), generation: this.generation, ping, snapshot };
      this.send(peerId, { type: 'grant', ...peer.grant });
    }
    for (const mark of this.state.marks.filter(m => m.peerId === peerId)) this.dismiss(mark.id);
    this.refresh();
  }
  pause() {
    for (const [peerId, peer] of this.peers) { peer.grant = undefined; this.send(peerId, { type: 'revoke' }); }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.update({ marks: [] }); this.refresh();
  }
  dismiss(markId: string) {
    clearTimeout(this.timers.get(markId)); this.timers.delete(markId);
    this.update({ marks: this.state.marks.filter(m => m.id !== markId) });
  }
  mark(peerId: string, kind: CopilotMode, x: number, y: number, image?: string, frozenMs = 0, laser = false) {
    if (!readCopilotSettings().enabled) throw new Error('Enable visual copilot in Settings first.');
    if (!Number.isFinite(frozenMs) || frozenMs < 0 || frozenMs > 60_000) throw new Error('This frozen frame expired. Capture a new frame.');
    const grant = this.state.offers[peerId];
    if (!grant?.[kind]) throw new Error('The sharer has not allowed this action.');
    if (!coordinate(x) || !coordinate(y) || (kind === 'snapshot' && !isCopilotImage(image))) throw new Error('The marked image is unavailable or too large.');
    // Movement is expendable: never add it behind buffered media collaboration messages.
    if (laser && (this.peers.get(peerId)?.channel.bufferedAmount ?? 1) > 0) return;
    if (this.pending.size >= 4) throw new Error('Wait for your previous indications to arrive.');
    const markId = crypto.randomUUID();
    const sent = this.send(peerId, { type: 'mark', id: markId, token: grant.token, generation: grant.generation, kind, x, y, ...(laser && kind === 'ping' ? { laser: true } : {}),
      ...(kind === 'snapshot' ? { image, frozenMs: Math.min(60_000, Math.max(0, frozenMs)) } : {}) });
    if (!sent) throw new Error('The visual collaboration connection is unavailable.');
    const timer = setTimeout(() => { this.pending.delete(markId); this.update({ status: 'No acknowledgement. The indication may not have arrived.' }); }, 5000);
    this.pending.set(markId, { peerId, timer });
    this.update({ status: 'Sending indication…' });
  }
  private send(peerId: string, message: Record<string, unknown>) {
    const channel = this.peers.get(peerId)?.channel;
    const data = JSON.stringify({ v: 1, ...message });
    if (!channel || channel.readyState !== 'open' || data.length > MAX_MESSAGE || channel.bufferedAmount > MAX_MESSAGE * 2) return false;
    try { channel.send(data); return true; } catch { return false; }
  }
  private receive(peerId: string, raw: unknown) {
    const peer = this.peers.get(peerId);
    if (!peer || this.disposed || typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    if (performance.now() - peer.receivedAt > 1000) { peer.receivedAt = performance.now(); peer.receivedCount = 0; }
    if (++peer.receivedCount > 40) { this.detach(peerId); return; }
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || m.v !== 1) return;
    if (m.type === 'hello') { peer.ready = true; this.refresh(); return; }
    if (!peer.ready) return;
    if (m.type === 'grant' && id(m.token) && id(m.generation) && typeof m.ping === 'boolean' && typeof m.snapshot === 'boolean') {
      this.update({ offers: { ...this.state.offers, [peerId]: { token: m.token, generation: m.generation, ping: m.ping, snapshot: m.snapshot } } }); return;
    }
    if (m.type === 'revoke') { const offers = { ...this.state.offers }; delete offers[peerId]; this.update({ offers }); return; }
    if (m.type === 'ack' && id(m.id)) {
      const pending = this.pending.get(m.id);
      if (pending?.peerId === peerId) { clearTimeout(pending.timer); this.pending.delete(m.id); this.update({ status: m.accepted === true ? 'Received by the sharer.' : 'Indication rejected or permission expired.' }); }
      return;
    }
    if (m.type !== 'mark' || !id(m.id)) return;
    const kind = m.kind;
    const settings = readCopilotSettings();
    const allowed = settings.enabled && (kind === 'ping' ? settings.showPings : settings.showCards) && this.source?.readyState === 'live' && peer.grant && m.token === peer.grant.token && m.generation === this.generation
      && (kind === 'ping' || kind === 'snapshot') && peer.grant[kind] && coordinate(m.x) && coordinate(m.y)
      && (kind !== 'snapshot' || (isCopilotImage(m.image) && typeof m.frozenMs === 'number' && Number.isFinite(m.frozenMs) && m.frozenMs >= 0 && m.frozenMs <= 60_000))
      && !peer.seen.has(m.id) && performance.now() - peer.lastMark >= (m.laser === true && kind === 'ping' ? 100 : 500);
    if (!allowed) { this.send(peerId, { type: 'ack', id: m.id, accepted: false }); return; }
    peer.lastMark = performance.now(); peer.seen.add(m.id);
    if (peer.seen.size > 64) peer.seen.delete(peer.seen.values().next().value!);
    const lifetime = kind === 'ping' ? readCopilotSettings().duration * 1000 : (readCopilotSettings().cardSeconds || 60) * 1000;
    const laser = kind === 'ping' && m.laser === true;
    const receivedId = laser ? `laser-${peerId}` : m.id;
    if (laser) { clearTimeout(this.timers.get(receivedId)); this.timers.delete(receivedId); }
    const mark: CopilotMark = { id: receivedId, laser, peerId, kind: kind as CopilotMode, x: m.x as number, y: m.y as number,
      image: kind === 'snapshot' ? m.image as string : undefined, frozenMs: kind === 'snapshot' ? m.frozenMs as number : undefined, expires: performance.now() + lifetime };
    if (this.state.marks.length >= 5 && !this.state.marks.some(existing => existing.id === receivedId)) this.dismiss(this.state.marks[0]!.id);
    this.update({ marks: [...this.state.marks.filter(existing => existing.id !== receivedId), mark] });
    this.timers.set(mark.id, setTimeout(() => this.dismiss(mark.id), lifetime));
    this.send(peerId, { type: 'ack', id: m.id, accepted: true });
  }
  dispose() {
    if (typeof window !== 'undefined') { window.removeEventListener('bc-visual-copilot', this.settingsChanged); window.removeEventListener('storage', this.settingsChanged); }
    this.pause(); this.source?.removeEventListener('ended', this.sourceEnded); this.source = null;
    for (const peerId of [...this.peers.keys()]) this.detach(peerId);
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear(); this.disposed = true; this.update(empty()); this.listeners.clear();
  }
}

export type CopilotSettings = {
  enabled: boolean; showPings: boolean; showCards: boolean; duration: number; size: number;
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; cardWidth: number;
  cardSeconds: number; animate: boolean; pingKey: string; snapshotKey: string;
};
export const copilotDefaults: CopilotSettings = { enabled: false, showPings: true, showCards: true, duration: 2, size: 40, corner: 'top-right', cardWidth: 320, cardSeconds: 15, animate: true, pingKey: '', snapshotKey: '' };
export function readCopilotSettings(): CopilotSettings {
  try {
    const s = JSON.parse(localStorage.getItem('bc-visual-copilot-v1') ?? localStorage.getItem('bc-visual-copilot') ?? '{}');
    return { enabled: s.enabled === true, showPings: s.showPings !== false, showCards: s.showCards !== false,
      duration: [1, 2, 4].includes(s.duration) ? s.duration : 2, size: [24, 40, 56].includes(s.size) ? s.size : 40,
      corner: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(s.corner) ? s.corner : 'top-right',
      cardWidth: [240, 320, 400].includes(s.cardWidth) ? s.cardWidth : 320, cardSeconds: [5, 15, 30, 0].includes(s.cardSeconds) ? s.cardSeconds : 15,
      animate: s.animate !== false, pingKey: typeof s.pingKey === 'string' && /^(Key[A-Z]|F[1-9]|F1[0-2])$/.test(s.pingKey) ? s.pingKey : '',
      snapshotKey: typeof s.snapshotKey === 'string' && /^(Key[A-Z]|F[1-9]|F1[0-2])$/.test(s.snapshotKey) ? s.snapshotKey : '' };
  } catch { return { ...copilotDefaults }; }
}
export function writeCopilotSettings(settings: CopilotSettings) { localStorage.setItem('bc-visual-copilot-v1', JSON.stringify(settings)); window.dispatchEvent(new Event('bc-visual-copilot')); }

/** Screen-space -> decoded-frame coordinates, including object fit and zoom. */
export function videoPoint(px: number, py: number, box: { left: number; top: number; width: number; height: number }, width: number, height: number, fit: 'contain' | 'cover') {
  if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0) return null;
  const scale = fit === 'cover' ? Math.max(box.width / width, box.height / height) : Math.min(box.width / width, box.height / height);
  const x = (px - box.left - (box.width - width * scale) / 2) / (width * scale);
  const y = (py - box.top - (box.height - height * scale) / 2) / (height * scale);
  return coordinate(x) && coordinate(y) ? { x, y } : null;
}
