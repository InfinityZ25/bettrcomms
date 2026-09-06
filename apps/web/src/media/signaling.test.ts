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
