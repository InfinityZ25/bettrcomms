import { beforeEach, expect, it, vi } from 'vitest';
import { allowDesktopCapture, isWindowsDesktop, openDesktopPrivacySettings } from './permissions';

const mock = vi.hoisted(() => ({ platform: 'windows', token: 'test-page-token', open: vi.fn() }));
vi.mock('../desktop/runtime', () => ({ getDesktopRuntime: () => 'wails', readDesktopBootReport: () => ({ platform: mock.platform, pageToken: mock.token }) }));
vi.mock('../desktop/wailsbindings/bettercomms/desktop-wails/nativemediaservice', () => ({ MediaPermissionOpenSettings: mock.open }));

beforeEach(() => { vi.clearAllMocks(); mock.platform = 'windows'; mock.token = 'test-page-token'; });

it('identifies Windows Wails and uses its standing permission policy', async () => {
  expect(await isWindowsDesktop()).toBe(true);
  await allowDesktopCapture('camera');
  await allowDesktopCapture('microphone');
});

it('opens only the requested native privacy page with page authorisation', async () => {
  await openDesktopPrivacySettings('camera');
  expect(mock.open).toHaveBeenCalledWith(mock.token, 'camera');
});

it('does not expose Windows settings on other hosts or without a page token', async () => {
  mock.platform = 'darwin';
  expect(await isWindowsDesktop()).toBe(false);
  await expect(openDesktopPrivacySettings('microphone')).rejects.toThrow('Windows');
  mock.platform = 'windows'; mock.token = '';
  await expect(openDesktopPrivacySettings('microphone')).rejects.toThrow('authorise');
  expect(mock.open).not.toHaveBeenCalled();
});
