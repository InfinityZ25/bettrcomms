import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  isTauri: () => true,
}));

import { createNativeSystemAudio } from './nativeSystemAudio';

beforeEach(() => {
  mocks.invoke.mockReset();
});

it('requires explicit application-audio capability before forwarding a source ID', async () => {
  mocks.invoke.mockResolvedValueOnce({
    available: true,
    detail: 'Older native host',
  });

  await expect(
    createNativeSystemAudio(new AbortController().signal, mocks.invoke, 'opaque-window'),
  ).rejects.toThrow(/Update the desktop app/);

  expect(mocks.invoke).toHaveBeenCalledWith('native_system_audio_capabilities');
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    'native_system_audio_start',
    expect.anything(),
  );
});

it('passes the opaque source ID and cleans up a host that returns system mode', async () => {
  mocks.invoke.mockImplementation(async (command: string, args?: unknown) => {
    if (command === 'native_system_audio_capabilities')
      return { available: true, applicationAudio: true, detail: 'Ready' };
    if (command === 'native_system_audio_start')
      return { sessionId: 'audio-session', sampleRate: 48_000, channels: 2, mode: 'system' };
    if (command === 'native_system_audio_stop') return undefined;
    throw new Error(`Unexpected command ${command}: ${String(args)}`);
  });

  await expect(
    createNativeSystemAudio(new AbortController().signal, mocks.invoke, 'opaque-window'),
  ).rejects.toThrow(/did not provide isolated audio/);

  expect(mocks.invoke).toHaveBeenCalledWith('native_system_audio_start', {
    sourceId: 'opaque-window',
  });
  expect(mocks.invoke).toHaveBeenCalledWith('native_system_audio_stop', {
    sessionId: 'audio-session',
  });
});
