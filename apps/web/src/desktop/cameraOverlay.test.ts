import { beforeEach, expect, it, vi } from 'vitest';
import { closeCameraOverlay, openCameraOverlay, sendCameraOverlayFrame, updateCameraOverlay } from './cameraOverlay';

const mock = vi.hoisted(() => ({
  runtime: 'wails', token: 'fixture-token', invoke: vi.fn(),
  api: { CameraOverlayOpen: vi.fn(), CameraOverlayUpdate: vi.fn(), CameraOverlayFrame: vi.fn(), CameraOverlayClose: vi.fn() },
}));
vi.mock('./runtime', () => ({ getDesktopRuntime: () => mock.runtime, readDesktopBootReport: () => ({ pageToken: mock.token }) }));
vi.mock('./wailsbindings/bettercomms/desktop-wails/nativemediaservice', () => mock.api);
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }));
const options = { position: 'top-right', size: 'small', clickThrough: true, rows: 1 };
const session = { overlayId: 'overlay-fixture', width: 2, height: 1, maxFps: 24 };
beforeEach(() => { vi.resetAllMocks(); mock.runtime = 'wails'; mock.token = 'fixture-token'; });

it('opens an authorised Wails overlay, updates it and closes its exact grant', async () => {
  mock.api.CameraOverlayOpen.mockResolvedValue(session);
  expect(await openCameraOverlay(options)).toEqual(session);
  expect(mock.api.CameraOverlayOpen).toHaveBeenCalledWith(mock.token, options);
  await updateCameraOverlay(session.overlayId, { ...options, rows: 4 });
  expect(mock.api.CameraOverlayUpdate).toHaveBeenCalledWith(mock.token, session.overlayId, { ...options, rows: 4 });
  await closeCameraOverlay(session.overlayId);
  expect(mock.api.CameraOverlayClose).toHaveBeenCalledWith(mock.token, session.overlayId);
  expect(mock.invoke).not.toHaveBeenCalled();
});

it('preserves RGBA bytes including typed-array offsets through Go base64 bindings', async () => {
  const allocation = Uint8Array.from([99, 0, 255, 128, 1, 2, 3, 4, 5, 99]);
  const pixels = allocation.subarray(1, 9);
  await sendCameraOverlayFrame(session, pixels);
  const [token, id, width, height, encoded] = mock.api.CameraOverlayFrame.mock.calls[0];
  expect(token).toBe(mock.token);
  expect([id, width, height]).toEqual([session.overlayId, 2, 1]);
  expect(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))).toEqual(pixels);
});

it('waits for the native frame acknowledgement and propagates transport failures', async () => {
  let release!: () => void;
  mock.api.CameraOverlayFrame.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  const finished = vi.fn();
  const pending = sendCameraOverlayFrame(session, new Uint8Array(8)).then(finished);
  await vi.waitFor(() => expect(mock.api.CameraOverlayFrame).toHaveBeenCalledOnce());
  expect(finished).not.toHaveBeenCalled();
  release(); await pending;
  mock.api.CameraOverlayFrame.mockRejectedValue(new Error('closed'));
  await expect(sendCameraOverlayFrame(session, new Uint8Array(8))).rejects.toThrow('closed');
});

it('rejects malformed or oversized frames before native IPC', async () => {
  await expect(sendCameraOverlayFrame(session, new Uint8Array(7))).rejects.toThrow('dimensions');
  await expect(sendCameraOverlayFrame({ ...session, width: 641 }, new Uint8Array(2564))).rejects.toThrow('dimensions');
  expect(mock.api.CameraOverlayFrame).not.toHaveBeenCalled();
});

it('refuses browser access and missing page authorisation', async () => {
  mock.token = '';
  await expect(openCameraOverlay(options)).rejects.toThrow('authorise');
  mock.runtime = 'browser';
  await expect(openCameraOverlay(options)).rejects.toThrow('desktop');
  expect(mock.api.CameraOverlayOpen).not.toHaveBeenCalled();
});

it('preserves the Tauri binary IPC contract', async () => {
  mock.runtime = 'tauri';
  const pixels = new Uint8Array(8);
  await openCameraOverlay(options);
  await sendCameraOverlayFrame(session, pixels);
  expect(mock.invoke).toHaveBeenCalledWith('camera_overlay_open', options);
  expect(mock.invoke).toHaveBeenCalledWith('camera_overlay_frame', pixels, { headers: {
    'x-bettercomms-overlay-id': session.overlayId,
    'x-bettercomms-frame-width': '2', 'x-bettercomms-frame-height': '1',
  } });
  expect(mock.api.CameraOverlayFrame).not.toHaveBeenCalled();
});
