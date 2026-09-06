import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

test('processed microphone activity uses hysteresis and releases meters without owning tracks', async ({
  page,
}) => {
  await page.goto(baseURL);
  const setup = await page.evaluate(async () => {
    const sourceContext = new AudioContext({ sampleRate: 48_000 });
    const oscillator = sourceContext.createOscillator();
    const gain = sourceContext.createGain();
    const destination = sourceContext.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    // Quiet but audible speech level (~-43 dBFS), below the old -29 dBFS threshold.
    gain.gain.value = 0.01;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await sourceContext.resume();
    const track = destination.stream.getAudioTracks()[0];
    let stopCalls = 0;
    const originalStop = track.stop.bind(track);
    track.stop = () => {
      stopCalls += 1;
      originalStop();
    };

    const meterContexts: AudioContext[] = [];
    const OriginalAudioContext = window.AudioContext;
    class TrackedAudioContext extends OriginalAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        meterContexts.push(this);
      }
    }
    window.AudioContext = TrackedAudioContext;
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const ReactDOM = (await import(
      '/node_modules/.vite/deps/react-dom_client.js'
    )).default;
    const { useSpeakingActivity } = await import(
      '/src/media/useSpeakingActivity.ts'
    );
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = ReactDOM.createRoot(host);
    let activityEnabled = true;
    function Fixture() {
      // A fresh array on every render exercises reference-based reconciliation.
      const active = useSpeakingActivity(
        [{ id: 'processed-mic', track }],
        activityEnabled,
      );
      return React.createElement('output', {
        'data-speaking': active.has('processed-mic') ? 'yes' : 'no',
      });
    }
    const render = (enabled: boolean) => {
      activityEnabled = enabled;
      root.render(React.createElement(Fixture));
    };
    render(true);
    Object.assign(window as any, {
      __speakingFixture: {
        silence: () => (gain.gain.value = 0),
        tone: () => (gain.gain.value = 0.01),
        background: () => (gain.gain.value = 0.001),
        disableTrack: () => (track.enabled = false),
        enableTrack: () => (track.enabled = true),
        rerender: () => render(true),
        unmount: async () => {
          root.unmount();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            stopCalls,
            trackState: track.readyState,
            contextCount: meterContexts.length,
            contextStates: meterContexts.map((context) => context.state),
          };
        },
        cleanup: async () => {
          window.AudioContext = OriginalAudioContext;
          oscillator.stop();
          originalStop();
          await sourceContext.close();
        },
      },
    });
    return { trackState: track.readyState };
  });
  expect(setup.trackState).toBe('live');
  const output = page.locator('output');
  await expect(output).toHaveAttribute('data-speaking', 'yes', { timeout: 2_000 });

  await page.evaluate(async () => {
    const { saveSpeakingThreshold } = await import('/src/media/speakingSensitivity.ts');
    saveSpeakingThreshold(-35);
  });
  await expect(output).toHaveAttribute('data-speaking', 'no');
  await page.evaluate(async () => {
    const { saveSpeakingThreshold } = await import('/src/media/speakingSensitivity.ts');
    saveSpeakingThreshold(-48);
  });
  await expect(output).toHaveAttribute('data-speaking', 'yes');
  await page.evaluate(() => (window as any).__speakingFixture.background());
  await expect(output).toHaveAttribute('data-speaking', 'no');
  await page.waitForTimeout(300);
  await expect(output).toHaveAttribute('data-speaking', 'no');
  await page.evaluate(() => (window as any).__speakingFixture.tone());
  await expect(output).toHaveAttribute('data-speaking', 'yes');

  await page.evaluate(() => (window as any).__speakingFixture.rerender());
  await page.waitForTimeout(100);
  await page.evaluate(() => (window as any).__speakingFixture.silence());
  await expect(output).toHaveAttribute('data-speaking', 'no', { timeout: 1_000 });

  await page.evaluate(() => {
    (window as any).__speakingFixture.tone();
    (window as any).__speakingFixture.disableTrack();
  });
  await expect(output).toHaveAttribute('data-speaking', 'no');
  await page.evaluate(() => (window as any).__speakingFixture.enableTrack());
  await expect(output).toHaveAttribute('data-speaking', 'yes', { timeout: 1_000 });

  const cleanup = await page.evaluate(() =>
    (window as any).__speakingFixture.unmount(),
  );
  expect(cleanup).toEqual({
    stopCalls: 0,
    trackState: 'live',
    contextCount: 1,
    contextStates: ['closed'],
  });
  await page.evaluate(() => (window as any).__speakingFixture.cleanup());
});

test('speaking threshold is adjustable and persists without opening a device', async ({ page }) => {
  await page.goto(`${baseURL}/#/settings`);
  const threshold = page.getByRole('slider', { name: 'Speaking indicator threshold', exact: true });
  await expect(threshold).toHaveValue('-48');
  await threshold.fill('-55');
  await expect(page.getByText('Speaking indicator threshold · -55 dBFS')).toBeVisible();
  await page.reload();
  await expect(threshold).toHaveValue('-55');
  expect(await page.evaluate(() => localStorage.getItem('bc-processing'))).toBeNull();
});
