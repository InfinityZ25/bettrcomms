import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ platform: '' }));
vi.mock('../desktop/runtime', () => ({ readDesktopBootReport: () => runtime.platform ? { platform: runtime.platform } : null }));
import { applyOutputDevice, followOutputDevice } from './output';
beforeEach(() => { runtime.platform = ''; vi.stubGlobal('localStorage', { getItem: () => 'chosen-headset' }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('leaves native iPhone audio routing alone when incoming audio or devices change', async () => {
 runtime.platform = 'ios';
 vi.stubGlobal('window', new EventTarget());
 vi.stubGlobal('navigator', { mediaDevices: new EventTarget() });
 const setSinkId = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
 const onError = vi.fn();
 const stop = followOutputDevice({ setSinkId } as unknown as HTMLMediaElement, onError);
 navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
 window.dispatchEvent(new Event('bc-output'));
 await new Promise(resolve => setTimeout(resolve, 0));
 stop();
 expect(setSinkId).not.toHaveBeenCalled();
 expect(onError).not.toHaveBeenCalled();
});
it('continues selecting a browser output', async () => {
 const setSinkId = vi.fn().mockResolvedValue(undefined);
 await applyOutputDevice({ setSinkId } as unknown as HTMLMediaElement);
 expect(setSinkId).toHaveBeenCalledWith('chosen-headset');
});
it('continues reporting actual desktop output failures', async () => {
 runtime.platform = 'darwin';
 const setSinkId = vi.fn().mockRejectedValue(new Error('missing'));
 await expect(applyOutputDevice({ setSinkId } as unknown as HTMLMediaElement)).rejects.toThrow('Could not use the selected output');
});
