import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '@/api';
import { accountPreferencesSnapshot, receiveAccountPreferences, setPreferenceSync, startAccountPreferences, validAccountPreferences } from './accountPreferences';
import { applyTheme, callPreferencesSnapshot, setCallLayout, setVoiceBalance } from './localPreferences';
import { publishPreferenceChange } from './preferenceEvents';
import { setSoundsEnabled, setSoundEnabled, soundPreferenceEnabled } from '@/media/sounds';

vi.mock('@/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api')>()), api: vi.fn() }));
let stop: (() => void) | undefined;
let values: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers(); values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal('window', new EventTarget());
  applyTheme('dark'); setCallLayout('top'); setVoiceBalance(false); setSoundsEnabled(true); setSoundEnabled('notification', true);
  vi.mocked(api).mockResolvedValue({ version: 1, settings: { theme: 'light', layout: 'top' } });
});
afterEach(() => { stop?.(); stop = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('portable account preferences', () => {
  it('requires device opt-in and leaves device capture and permissions outside the whitelist', async () => {
    stop = startAccountPreferences('me');
    publishPreferenceChange({ layout: 'side' });
    await vi.advanceTimersByTimeAsync(400);
    expect(api).not.toHaveBeenCalled();
    expect(validAccountPreferences({ version: 1, settings: { microphone: 'device-id' } })).toBe(false);
    expect(validAccountPreferences({ version: 1, settings: { push_to_talk: true } })).toBe(false);
    expect(validAccountPreferences({ version: 1, settings: { sound_volume: NaN } })).toBe(false);
    setPreferenceSync(true);
    await Promise.resolve();
    expect(accountPreferencesSnapshot()).toMatchObject({ enabled: true, ready: true, version: 1 });
    expect(values.get('bettercomms-ui-theme')).toBe('light');
  });
  it('debounces only changed fields and never uploads remote-applied settings', async () => {
    values.set('bc-preference-sync:me', 'on'); stop = startAccountPreferences('me'); await Promise.resolve();
    vi.mocked(api).mockResolvedValue({ version: 2, settings: { theme: 'light', layout: 'right', balanced: true } });
    setCallLayout('side'); setCallLayout('right'); setVoiceBalance(true);
    await vi.advanceTimersByTimeAsync(349);
    expect(api).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenLastCalledWith('/me/preferences', { version: 1, settings: { layout: 'right', balanced: true } }, 'PATCH', expect.any(AbortSignal));
    receiveAccountPreferences({ version: 3, settings: { layout: 'side', sounds: { notification: false } } });
    expect(callPreferencesSnapshot().layout).toBe('side');
    expect(soundPreferenceEnabled('notification')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('merges concurrent updates with the latest version instead of replacing another devices choices', async () => {
    values.set('bc-preference-sync:me', 'on');
    vi.mocked(api).mockResolvedValueOnce({ version: 1, settings: { theme: 'dark' } });
    stop = startAccountPreferences('me'); await Promise.resolve();
    vi.mocked(api).mockRejectedValueOnce(new ApiRequestError('Conflict', 409))
      .mockResolvedValueOnce({ version: 2, settings: { theme: 'light', sounds: { join: false } } })
      .mockResolvedValueOnce({ version: 3, settings: { theme: 'light', layout: 'side', sounds: { join: false } } });
    setCallLayout('side'); await vi.advanceTimersByTimeAsync(350);
    expect(api).toHaveBeenLastCalledWith('/me/preferences', { version: 2, settings: { layout: 'side' } }, 'PATCH', expect.any(AbortSignal));
    expect(values.get('bettercomms-ui-theme')).toBe('light');
    expect(soundPreferenceEnabled('join')).toBe(false);
  });
  it('restores the device baseline on sign out without leaking the prior accounts theme', async () => {
    values.set('bc-preference-sync:alice', 'on'); stop = startAccountPreferences('alice'); await Promise.resolve();
    expect(values.get('bettercomms-ui-theme')).toBe('light');
    stop(); stop = undefined;
    expect(values.get('bettercomms-ui-theme')).toBe('dark');
    stop = startAccountPreferences('bob');
    expect(accountPreferencesSnapshot()).toMatchObject({ userId: 'bob', enabled: false });
    expect(values.get('bettercomms-ui-theme')).toBe('dark');
  });
  it('keeps unsaved local edits visible during a request, then accepts a newer authoritative event', async () => {
    values.set('bc-preference-sync:me', 'on'); stop = startAccountPreferences('me'); await Promise.resolve();
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    setCallLayout('side'); await vi.advanceTimersByTimeAsync(350);
    receiveAccountPreferences({ version: 3, settings: { layout: 'right' } });
    expect(callPreferencesSnapshot().layout).toBe('side');
    finish({ version: 2, settings: { layout: 'side' } });
    await Promise.resolve(); await Promise.resolve();
    expect(callPreferencesSnapshot().layout).toBe('right');
    expect(accountPreferencesSnapshot().version).toBe(3);
  });
  it('does not leak a delayed snapshot across accounts and tolerates stale cleanup', async () => {
    values.set('bc-preference-sync:alice', 'on');
    let finish!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldStop = startAccountPreferences('alice'); stop = startAccountPreferences('bob'); oldStop();
    finish({ version: 9, settings: { theme: 'light' } }); await Promise.resolve();
    expect(accountPreferencesSnapshot()).toMatchObject({ userId: 'bob', enabled: false, version: 0 });
    expect(values.get('bettercomms-ui-theme')).toBe('dark');
  });
  it('disabling sync stops writes but keeps your currently selected device settings', async () => {
    stop = startAccountPreferences('me'); setPreferenceSync(true); await Promise.resolve();
    setCallLayout('side'); setPreferenceSync(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api).toHaveBeenCalledTimes(1);
    expect(callPreferencesSnapshot().layout).toBe('side');
    stop(); stop = undefined;
    expect(values.get('bettercomms-ui-theme')).toBe('light');
  });
});
