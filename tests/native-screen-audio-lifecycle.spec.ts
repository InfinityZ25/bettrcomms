import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test('native screen stop and engine disposal release the coupled system-audio session', async ({
  page,
}) => {
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const commands: string[] = [];
    (window as unknown as { isTauri: boolean }).isTauri = true;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          commands.push(command);
          if (command === 'native_system_audio_start')
            return {
              sessionId: `audio-${commands.length}`,
              sampleRate: 48_000,
              channels: 2,
            };
          if (command === 'native_system_audio_read') return new ArrayBuffer(0);
          if (command === 'native_system_audio_stop') return null;
          throw new Error(`Unexpected native command: ${command}`);
        },
      },
    });

    const { MediaEngine } = await import('/src/media/engine.ts');
    const signaling = Object.assign(new EventTarget(), {
      localPeerId: 'local',
      send: async () => undefined,
    });
    const options = {
      sourceId: 'window-1',
      encoder: 'h264_amf' as const,
      width: 1920,
      height: 1080,
      fps: 60 as const,
      bitrateMbps: 20 as const,
      cursor: true,
      systemAudio: true,
    };
    const runs: Array<{
      before: Record<string, string | undefined>;
      after: Record<string, string | undefined>;
    }> = [];
    for (const action of ['stop', 'dispose'] as const) {
        const engine = new MediaEngine({ signaling });
        const transport = (engine as any).nativeScreen;
        transport.start = async (startOptions: typeof options) => {
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 16;
          const stream = canvas.captureStream(1);
          transport.__testPreview = stream.getVideoTracks()[0];
          transport.session = {
            ...startOptions,
            sessionId: `screen-${action}`,
          };
          transport.onPreview(transport.__testPreview);
        };
        transport.stop = async () => {
          transport.session = undefined;
          transport.onPreview(null);
        };
        transport.dispose = () => {
          transport.session = undefined;
          transport.onPreview(null);
        };
        const tracks = new Map<string, MediaStreamTrack | null>();
        engine.addEventListener('local-track', (event) => {
          tracks.set(event.detail.source, event.detail.track);
        });
        await engine.captureNativeScreen(options);
        const screen = tracks.get('screen');
        const system = tracks.get('system');
        const before = {
          screen: screen?.readyState,
          system: system?.readyState,
        };
        if (action === 'stop') await engine.stopNativeScreen();
        else engine.dispose();
        await new Promise((resolve) => setTimeout(resolve, 50));
        runs.push({
          before,
          after: {
            screen: screen?.readyState,
            system: system?.readyState,
          },
        });
        if (action === 'stop') engine.dispose();
    }
    return { runs, commands };
  });

  expect(result.runs).toEqual([
    {
      before: { screen: 'live', system: 'live' },
      after: { screen: 'ended', system: 'ended' },
    },
    {
      before: { screen: 'live', system: 'live' },
      after: { screen: 'ended', system: 'ended' },
    },
  ]);
  expect(
    result.commands.filter((command) => command === 'native_system_audio_start'),
  ).toHaveLength(2);
  expect(
    result.commands.filter((command) => command === 'native_system_audio_stop'),
  ).toHaveLength(2);
});
