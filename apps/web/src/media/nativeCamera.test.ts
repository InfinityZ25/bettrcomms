import { afterEach, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../desktop/iosNativeBindings', () => ({ callIOSMetaSender: invoke }));
vi.mock('./metaGlassesCamera', () => ({ hasMetaGlassesCamera: () => true }));
vi.mock('../desktop/capture', () => ({ invokeNativeCapture: vi.fn(), onNativeCaptureEnded: vi.fn() }));

import { NativeCameraTransport } from './nativeCamera';
import { NativeScreenTransport } from './nativeScreen';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); invoke.mockReset(); });

it('unregisters its signaling error handler when disposed', () => {
  const signaling = Object.assign(new EventTarget(), { localPeerId: 'self', send: vi.fn() });
  const add = vi.spyOn(signaling, 'addEventListener');
  const remove = vi.spyOn(signaling, 'removeEventListener');
  const transport = new NativeCameraTransport(signaling, [], false, vi.fn(), vi.fn(), vi.fn());
  signaling.dispatchEvent(new CustomEvent('error', { detail: { code: 'offline' } }));
  expect(invoke).toHaveBeenCalledWith('native_camera_trace', { event: 'signaling-error offline' });
  transport.dispose();
  expect(remove).toHaveBeenCalledWith('error', add.mock.calls[0][1]);
  invoke.mockClear();
  signaling.dispatchEvent(new CustomEvent('error', { detail: { code: 'offline' } }));
  expect(invoke).not.toHaveBeenCalled();
});

function nativePeerFixture() {
  vi.useFakeTimers();
  const signaling = Object.assign(new EventTarget(), { localPeerId: 'self', send: vi.fn() });
  vi.spyOn(NativeScreenTransport.prototype, 'sessionId', 'get').mockReturnValue('capture');
  const probe = vi.spyOn(NativeScreenTransport.prototype, 'probePeers');
  const add = vi.spyOn(NativeScreenTransport.prototype, 'addPeer').mockResolvedValue();
  const end = vi.spyOn(NativeScreenTransport.prototype, 'endOutboundPeer').mockResolvedValue();
  vi.spyOn(NativeScreenTransport.prototype, 'hasOutboundPeer').mockReturnValue(true);
  invoke.mockImplementation(async command => command === 'native_screen_peer_connected' ? { connected: true } : undefined);
  const camera = new NativeCameraTransport(signaling, [], false, vi.fn(), vi.fn(), vi.fn());
  return { camera, probe, add, end };
}

it('retries a lost capability query and connects without restarting capture', async () => {
  const { camera, probe, add } = nativePeerFixture();
  probe.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set(['peer']));
  const connected = camera.connectPeer('peer');
  await vi.advanceTimersByTimeAsync(1_500);
  expect(await connected).toBe(true);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(add).toHaveBeenCalledExactlyOnceWith('peer');
  expect(invoke).not.toHaveBeenCalledWith('native_screen_start', expect.anything());
  camera.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds unanswered capability queries and keeps the ordinary camera fallback', async () => {
  const { camera, probe, add } = nativePeerFixture();
  probe.mockImplementation(async (_peers, timeout) => {
    await new Promise(resolve => setTimeout(resolve, timeout));
    return new Set();
  });
  const connected = camera.connectPeer('peer');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await connected).toBe(false);
  expect(probe).toHaveBeenCalledTimes(8);
  expect(add).not.toHaveBeenCalled();
  camera.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['remove', 'stop', 'dispose'] as const)('cancels a waiting capability retry on %s', async action => {
  const { camera, probe, add } = nativePeerFixture();
  probe.mockResolvedValue(new Set());
  const connected = camera.connectPeer('peer');
  await vi.advanceTimersByTimeAsync(100);
  if (action === 'remove') camera.removePeer('peer');
  if (action === 'stop') await camera.stop();
  if (action === 'dispose') camera.dispose();
  expect(await connected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(probe).toHaveBeenCalledOnce();
  expect(add).not.toHaveBeenCalled();
  camera.dispose();
});

it('ignores a capability reply from a superseded attempt for the same participant', async () => {
  const { camera, probe, add } = nativePeerFixture();
  let reply!: (supported: Set<string>) => void;
  probe.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }))
    .mockResolvedValue(new Set(['peer']));
  const previous = camera.connectPeer('peer');
  const replacement = camera.connectPeer('peer');
  reply(new Set(['peer']));
  expect(await previous).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  expect(await replacement).toBe(true);
  expect(add).toHaveBeenCalledOnce();
  camera.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
