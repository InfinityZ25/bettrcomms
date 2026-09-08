import { afterEach, expect, it, vi } from 'vitest';
import { RoomWebSocketSignaling } from './signaling';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('delivers native screen stop messages with their capture identity', async () => {
  let socket: FakeSocket;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    send = vi.fn();
    constructor() {
      socket = this;
      queueMicrotask(() => this.onopen?.());
    }
    close() {
      this.readyState = 3;
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', {
    location: { href: 'http://localhost:5173' },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  const signaling = new RoomWebSocketSignaling(
    'local',
    '/api/v1/rooms/test/ws',
  );
  const received = vi.fn();
  signaling.addEventListener('signal', (event) => received(event.detail));
  await signaling.connect();
  const stop = {
    type: 'signal',
    from: 'peer',
    to: 'local',
    transport: 'native-screen',
    captureId: 'capture',
    data: { kind: 'native-screen-stop', captureId: 'capture' },
  };
  socket!.onmessage?.({ data: JSON.stringify(stop) });
  expect(received).toHaveBeenCalledExactlyOnceWith(stop);
  signaling.close();
});

it('measures only a matching server pong and reports a timeout', async () => {
  vi.useFakeTimers();
  let socket: FakeSocket;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    send = vi.fn();
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    close() { this.readyState = 3; }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', {
    location: { href: 'http://localhost:5173' },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const signaling = new RoomWebSocketSignaling('local', '/api/v1/rooms/test/ws');
  const latency = vi.fn();
  signaling.addEventListener('latency', (event) => latency(event.detail.rttMs));
  await signaling.connect();
  const ping = JSON.parse(String(socket!.send.mock.calls[0][0])) as { request_id: string };
  vi.advanceTimersByTime(42);
  socket!.onmessage?.({ data: JSON.stringify({ type: 'pong', request_id: 'stale' }) });
  expect(latency).not.toHaveBeenCalled();
  socket!.onmessage?.({ data: JSON.stringify({ type: 'pong', request_id: ping.request_id }) });
  expect(latency).toHaveBeenLastCalledWith(42);
  vi.advanceTimersByTime(5_000);
  vi.advanceTimersByTime(10_000);
  expect(latency).toHaveBeenLastCalledWith(null);
  signaling.close();
});

it('keeps device peer identities separate from account identities', async () => {
  let socket: FakeSocket;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    send = vi.fn();
    constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
    close() { this.readyState = 3; }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', {
    location: { href: 'http://localhost:5173' },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const signaling = new RoomWebSocketSignaling('device-local', '/api/v1/rooms/test/ws');
  const peers = vi.fn();
  const joined = vi.fn();
  signaling.addEventListener('peers', event => peers(event.detail));
  signaling.addEventListener('peer-joined', event => joined(event.detail));
  await signaling.connect();
  socket!.onmessage?.({ data: JSON.stringify({
    type: 'peers',
    payload: { peers: ['device-a'], identities: { 'device-a': { user_id: 'account-a', name: 'Ada' } } },
  }) });
  socket!.onmessage?.({ data: JSON.stringify({ type: 'peer.joined', from: 'device-b', user_id: 'account-a', name: 'Ada' }) });
  expect(peers).toHaveBeenCalledWith({ peerIds: ['device-a'], identities: { 'device-a': { userId: 'account-a', name: 'Ada' } } });
  expect(joined).toHaveBeenCalledWith({ peerId: 'device-b', userId: 'account-a', name: 'Ada' });
  signaling.close();
});

it('keeps the session alive across a signaling restart and gives up only after retrying', async () => {
  vi.useFakeTimers();
  const sockets: FakeReconnectSocket[] = [];
  let failNext = 0;
  class FakeReconnectSocket {
    static OPEN = 1;
    readyState = 0;
    url: string;
    onopen?: () => void;
    onclose?: (event: { code: number; wasClean: boolean }) => void;
    onerror?: (event: unknown) => void;
    onmessage?: (event: { data: string }) => void;
    send = vi.fn();
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => {
        if (failNext > 0) {
          failNext -= 1;
          this.readyState = 3;
          this.onclose?.({ code: 1006, wasClean: false });
          return;
        }
        this.readyState = 1;
        this.onopen?.();
      });
    }
    drop() {
      this.readyState = 3;
      this.onclose?.({ code: 1006, wasClean: false });
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000, wasClean: true });
    }
  }
  vi.stubGlobal('WebSocket', FakeReconnectSocket);
  vi.stubGlobal('window', {
    location: { href: 'http://localhost:5173' },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const signaling = new RoomWebSocketSignaling('local', '/api/v1/rooms/test/ws?peer_id=local&join_mode=replace');
  const disconnected = vi.fn(), reconnected = vi.fn(), closed = vi.fn();
  signaling.addEventListener('disconnected', () => disconnected());
  signaling.addEventListener('reconnected', () => reconnected());
  signaling.addEventListener('close', () => closed());
  await signaling.connect();

  // A server restart drops the socket. Established peer connections still carry
  // media, so this must not end the session.
  sockets[0].drop();
  expect(disconnected).toHaveBeenCalledTimes(1);
  expect(closed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reconnected).toHaveBeenCalledTimes(1);
  expect(closed).not.toHaveBeenCalled();
  // The same peer identity returns, and a resume never evicts this account's
  // other devices the way a deliberate replacing join is allowed to.
  expect(signaling.localPeerId).toBe('local');
  expect(sockets[1].url).toContain('peer_id=local');
  expect(sockets[1].url).toContain('join_mode=additional');

  // A restart that takes several attempts still recovers without ending it.
  failNext = 2;
  sockets.at(-1)!.drop();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(reconnected).toHaveBeenCalledTimes(2);
  expect(closed).not.toHaveBeenCalled();

  // A server that never returns eventually ends the session.
  failNext = 99;
  sockets.at(-1)!.drop();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(closed).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

it('treats an intentional close as the end of the session and stops retrying', async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onclose?: (event: { code: number; wasClean: boolean }) => void;
    onmessage?: (event: { data: string }) => void;
    send = vi.fn();
    constructor() {
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    close() { this.readyState = 3; this.onclose?.({ code: 1000, wasClean: true }); }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', {
    location: { href: 'http://localhost:5173' },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const signaling = new RoomWebSocketSignaling('local', '/api/v1/rooms/test/ws');
  const disconnected = vi.fn(), closed = vi.fn();
  signaling.addEventListener('disconnected', () => disconnected());
  signaling.addEventListener('close', () => closed());
  await signaling.connect();
  signaling.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(disconnected).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(1);
  vi.useRealTimers();
});

it('ends the session when the server closes it deliberately', async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen?: () => void;
    onclose?: (event: { code: number; wasClean: boolean }) => void;
    onerror?: (event: unknown) => void;
    onmessage?: (event: { data: string }) => void;
    send = vi.fn();
    constructor() {
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    evict() {
      this.readyState = 3;
      // Every deliberate server-side termination uses a policy violation:
      // replaced from another device, revoked membership, deleted room.
      this.onclose?.({ code: 1008, wasClean: false });
    }
    close() { this.readyState = 3; this.onclose?.({ code: 1000, wasClean: true }); }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', {
    location: { href: 'http://localhost:5173' },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const signaling = new RoomWebSocketSignaling('local', '/api/v1/rooms/test/ws');
  const disconnected = vi.fn(), closed = vi.fn();
  signaling.addEventListener('disconnected', () => disconnected());
  signaling.addEventListener('close', () => closed());
  await signaling.connect();
  sockets[0].evict();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(disconnected).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(1);
  vi.useRealTimers();
});
