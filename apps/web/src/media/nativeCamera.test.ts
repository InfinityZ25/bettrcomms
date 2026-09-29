import { expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../desktop/iosNativeBindings', () => ({ callIOSMetaSender: invoke }));
vi.mock('./metaGlassesCamera', () => ({ hasMetaGlassesCamera: () => true }));
vi.mock('../desktop/capture', () => ({ invokeNativeCapture: vi.fn(), onNativeCaptureEnded: vi.fn() }));

import { NativeCameraTransport } from './nativeCamera';

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
