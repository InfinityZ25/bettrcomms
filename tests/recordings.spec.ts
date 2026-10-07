import { expect, test } from '@playwright/test';

test('saved multitrack recording reloads, mixes, seeks, and deletes', async ({
  page,
}) => {
  await page.goto('/');
  const recordingTitle = `Synthetic mix ${Date.now()}`;

  const savedFixture = await page.evaluate(async (title) => {
    const declaredDurationMs = 1_400;
    const timesliceMs = 100;
    const waitUntil = async (ready: () => boolean, label: string) => {
      const deadline = performance.now() + 5_000;
      while (!ready()) {
        if (performance.now() >= deadline) throw new Error(label);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const rms = (analyser: AnalyserNode) => {
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(
        samples.reduce((sum, sample) => sum + sample * sample, 0) /
          samples.length,
      );
    };
    const record = async (
      stream: MediaStream,
      mimeType: string,
      clock: AudioContext,
    ) => {
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      let startedAt: number | undefined;
      let stopped = false;
      let failure: Error | undefined;
      recorder.onstart = () => {
        startedAt = clock.currentTime;
      };
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        failure = new Error('Synthetic recorder failed');
      };
      recorder.onstop = () => {
        stopped = true;
      };
      const ready = (predicate: () => boolean) => () => {
        if (failure) throw failure;
        return predicate();
      };
      try {
        recorder.start(timesliceMs);
        await waitUntil(
          ready(() => startedAt !== undefined),
          'Synthetic recorder did not start',
        );
        // Capture two encoder chunks beyond the declared timeline. Wall time can
        // advance while the audio device is still starting, so use its render clock.
        const captureSeconds = (declaredDurationMs + 2 * timesliceMs) / 1_000;
        await waitUntil(
          ready(() => clock.currentTime - startedAt! >= captureSeconds),
          `Synthetic recording audio clock stalled: ${clock.state}`,
        );
        recorder.stop();
        await waitUntil(
          ready(() => stopped),
          'Synthetic recorder did not emit its final data',
        );
        return new Blob(chunks, { type: mimeType });
      } finally {
        if (recorder.state !== 'inactive') recorder.stop();
      }
    };
    const validateVideo = async (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      const element = document.createElement('video');
      element.muted = true;
      element.preload = 'auto';
      element.src = url;
      const ready = (predicate: () => boolean) => () => {
        if (element.error)
          throw new Error(
            `Synthetic video decode failed: ${element.error.message}`,
          );
        return predicate();
      };
      try {
        element.load();
        await waitUntil(
          ready(() => element.readyState >= HTMLMediaElement.HAVE_METADATA),
          'Synthetic video metadata did not load',
        );
        if (!Number.isFinite(element.duration)) {
          // MediaRecorder WebM lacks a duration header; seeking resolves its end.
          element.currentTime = 1e10;
          await waitUntil(
            ready(() => Number.isFinite(element.duration)),
            'Synthetic video duration did not resolve',
          );
        }
        if (element.duration * 1_000 < declaredDurationMs)
          throw new Error(
            `Synthetic video is shorter than its manifest: ${element.duration}s`,
          );
        element.currentTime = 0;
        await waitUntil(
          ready(
            () =>
              element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              element.videoWidth === 320 &&
              element.videoHeight === 180,
          ),
          'Synthetic video frame did not decode',
        );
      } finally {
        element.pause();
        element.removeAttribute('src');
        element.load();
        URL.revokeObjectURL(url);
      }
    };

    const mimeType =
      ['video/webm;codecs=vp8,opus', 'video/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      ) ?? 'video/webm';
    const audioMimeType =
      ['audio/webm;codecs=opus', 'audio/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      ) ?? 'audio/webm';
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const graphics = canvas.getContext('2d')!;
    let frame = 0;
    const paint = window.setInterval(() => {
      graphics.fillStyle = frame++ % 2 ? '#c2ee91' : '#27352b';
      graphics.fillRect(0, 0, canvas.width, canvas.height);
      graphics.fillStyle = '#111315';
      graphics.font = 'bold 24px sans-serif';
      graphics.fillText('Bettercomms', 75, 98);
    }, 50);

    const makeTone = (frequency: number) => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.08;
      oscillator.connect(gain).connect(analyser).connect(destination);
      oscillator.start();
      return { context, oscillator, analyser, stream: destination.stream };
    };
    const first = makeTone(330);
    const second = makeTone(550);
    const videoStream = canvas.captureStream(20);

    try {
      await Promise.all([first.context.resume(), second.context.resume()]);
      await waitUntil(
        () =>
          first.context.currentTime >= 0.1 &&
          second.context.currentTime >= 0.1 &&
          rms(first.analyser) > 0.05 &&
          rms(second.analyser) > 0.05,
        'Synthetic microphones did not render samples',
      );
      const [video, microphone, guest] = await Promise.all([
        record(videoStream, mimeType, first.context),
        record(first.stream, audioMimeType, first.context),
        record(second.stream, audioMimeType, second.context),
      ]);
      const [ownerAudio, guestAudio] = await Promise.all([
        first.context.decodeAudioData(await microphone.arrayBuffer()),
        second.context.decodeAudioData(await guest.arrayBuffer()),
      ]);
      for (const [name, buffer] of [
        ['owner', ownerAudio],
        ['guest', guestAudio],
      ] as const) {
        if (buffer.duration * 1_000 < declaredDurationMs)
          throw new Error(
            `Synthetic ${name} audio is shorter than its manifest: ${buffer.duration}s`,
          );
      }
      await validateVideo(video);
      const startedAt = new Date().toISOString();
      const result = {
        manifest: {
          version: 1 as const,
          recordingId: `recording-e2e-${Date.now()}`,
          startedAt,
          stoppedAt: new Date(Date.parse(startedAt) + 1_800).toISOString(),
          replay: {
            status: 'unsupported' as const,
            reason: 'Synthetic fixture',
          },
          tracks: [
            {
              id: 'video-1',
              peerId: 'owner',
              source: 'camera' as const,
              mediaKind: 'video' as const,
              mimeType,
              fileName: 'camera.webm',
              startedOffsetMs: 0,
              durationMs: 1_400,
              bytes: video.size,
              status: 'complete' as const,
              endedReason: 'session-stopped' as const,
            },
            {
              id: 'video-2',
              peerId: 'owner',
              source: 'screen' as const,
              mediaKind: 'video' as const,
              mimeType,
              fileName: 'screen.webm',
              startedOffsetMs: 250,
              durationMs: 1_150,
              bytes: video.size,
              status: 'complete' as const,
              endedReason: 'session-stopped' as const,
            },
            {
              id: 'audio-1',
              peerId: 'owner',
              source: 'microphone' as const,
              mediaKind: 'audio' as const,
              mimeType: audioMimeType,
              fileName: 'owner.webm',
              startedOffsetMs: 0,
              durationMs: 1_400,
              bytes: microphone.size,
              status: 'complete' as const,
              endedReason: 'session-stopped' as const,
            },
            {
              id: 'audio-2',
              peerId: 'guest',
              source: 'microphone' as const,
              mediaKind: 'audio' as const,
              mimeType: audioMimeType,
              fileName: 'guest.webm',
              startedOffsetMs: 400,
              durationMs: 1_400,
              bytes: guest.size,
              status: 'error' as const,
              endedReason: 'recorder-error' as const,
              error: 'The final chunk may be incomplete.',
            },
          ],
        },
        files: [
          { name: 'camera.webm', blob: video },
          { name: 'screen.webm', blob: video },
          { name: 'owner.webm', blob: microphone },
          { name: 'guest.webm', blob: guest },
        ],
      };
      const { saveRecording } = await import('/src/media/recordingLibrary.ts');
      await saveRecording(result, {
        title,
        labels: { owner: 'Ada', guest: 'Grace' },
      });
      return {
        videoDigest: Array.from(
          new Uint8Array(
            await crypto.subtle.digest('SHA-256', await video.arrayBuffer()),
          ),
        )
          .map((value) => value.toString(16).padStart(2, '0'))
          .join(''),
      };
    } finally {
      clearInterval(paint);
      videoStream.getTracks().forEach((track) => track.stop());
      first.stream.getTracks().forEach((track) => track.stop());
      second.stream.getTracks().forEach((track) => track.stop());
      first.oscillator.stop();
      second.oscillator.stop();
      await Promise.all([first.context.close(), second.context.close()]);
    }
  }, recordingTitle);

  await page.reload();
  await page.getByRole('button', { name: 'Recordings', exact: true }).click();
  const recordingCard = page
    .locator('.library-open')
    .filter({ hasText: recordingTitle });
  await expect(recordingCard).toBeVisible();
  await page.screenshot({
    path: '.local/recordings-library.png',
    fullPage: true,
  });

  await recordingCard.click();
  await expect(
    page.getByRole('region', { name: 'Recording playback' }),
  ).toBeVisible();
  await expect(
    page.getByText('The final chunk may be incomplete.'),
  ).toBeVisible();
  await expect(page.getByText('Starts at 0:00')).toBeVisible();
  await page.getByLabel('Video source').selectOption({ label: 'Ada · screen' });
  await expect(page.getByLabel('Video source')).toHaveValue('video-2');
  await page.getByLabel('Video source').selectOption({ label: 'Ada · camera' });
  await page.getByText('Export tracks & timing manifest').click();
  const cameraDownload = page.getByRole('link', {
    name: 'Download original Ada · camera',
  });
  const linkedDigest = await cameraDownload.evaluate(
    async (link: HTMLAnchorElement) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            await (await fetch(link.href)).arrayBuffer(),
          ),
        ),
      )
        .map((value) => value.toString(16).padStart(2, '0'))
        .join(''),
  );
  expect(linkedDigest).toBe(savedFixture.videoDigest);
  const originalDownload = page.waitForEvent('download');
  await cameraDownload.click();
  const downloaded = await originalDownload;
  expect(downloaded.suggestedFilename()).toBe('camera.webm');
  const audioExport = page
    .locator('.recording-asset')
    .filter({
      has: page.getByRole('link', {
        name: 'Download original Ada · microphone',
      }),
    });
  await audioExport
    .getByLabel('Export format for Ada · microphone')
    .selectOption('wav');
  await audioExport
    .getByRole('button', { name: 'Convert', exact: true })
    .click();
  const wavDownload = audioExport.getByRole('link', { name: 'Download WAV' });
  await expect(wavDownload).toBeVisible();
  const wavHeader = await wavDownload.evaluate(
    async (link: HTMLAnchorElement) => {
      const bytes = new Uint8Array(
        await (await fetch(link.href)).arrayBuffer(),
      );
      return {
        container: String.fromCharCode(...bytes.slice(0, 4)),
        type: String.fromCharCode(...bytes.slice(8, 12)),
        bytes: bytes.length,
      };
    },
  );
  expect(wavHeader).toMatchObject({ container: 'RIFF', type: 'WAVE' });
  expect(wavHeader.bytes).toBeGreaterThan(10_000);
  const convertedDownload = page.waitForEvent('download');
  await wavDownload.click();
  expect((await convertedDownload).suggestedFilename()).toMatch(/\.wav$/);
  await page.screenshot({
    path: '.local/recording-export-formats.png',
    fullPage: true,
  });
  await page
    .getByTestId('workspace-scroll')
    .evaluate((element) => (element.scrollTop = 0));
  await page.screenshot({
    path: '.local/recording-player.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: '.local/recording-player-mobile.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });

  const ownerVolume = page.getByRole('slider', {
    name: 'Volume for Ada · microphone',
  });
  const guestVolume = page.getByRole('slider', {
    name: 'Volume for Grace · microphone',
  });
  await ownerVolume.fill('0.25');
  await expect(ownerVolume).toHaveValue('0.25');
  await expect(guestVolume).toHaveValue('1');
  await expect
    .poll(() =>
      page
        .locator('audio')
        .first()
        .evaluate((audio: HTMLAudioElement) => audio.volume),
    )
    .toBe(0.25);
  await page.getByRole('button', { name: 'Mute Grace · microphone' }).click();
  await expect(
    page.getByRole('button', { name: 'Unmute Grace · microphone' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('audio')
        .nth(1)
        .evaluate((audio: HTMLAudioElement) => audio.muted),
    )
    .toBe(true);

  await page.locator('audio').evaluateAll((elements) =>
    elements.forEach((element, index) => {
      element.dataset.fullscreenIdentity = `audio-${index}`;
    }),
  );
  await page.locator('video').evaluateAll((elements) =>
    elements.forEach((element, index) => {
      element.dataset.fullscreenIdentity = `video-${index}`;
    }),
  );

  await page
    .getByRole('slider', { name: 'Recording timeline' })
    .evaluate((input: HTMLInputElement) => {
      input.value = '600';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const timeBeforeFullscreen = await page
    .locator('audio')
    .first()
    .evaluate((audio: HTMLAudioElement) => audio.currentTime);

  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.fullscreenElement?.getAttribute('aria-label') ?? null,
      ),
    )
    .toBe('Recording playback');
  await expect(
    page.getByRole('button', { name: 'Exit fullscreen' }),
  ).toBeVisible();
  await expect(page.locator('audio[data-fullscreen-identity]')).toHaveCount(2);
  await expect(page.locator('video[data-fullscreen-identity]')).toHaveCount(2);
  await expect(ownerVolume).toHaveValue('0.25');
  await expect(
    page.getByRole('button', { name: 'Unmute Grace · microphone' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Hide audio mixer' }).click();
  await expect(ownerVolume).toBeHidden();
  await expect(page.locator('audio[data-fullscreen-identity]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Show audio mixer' }).click();
  await expect(ownerVolume).toBeVisible();
  await expect(ownerVolume).toHaveValue('0.25');
  await expect(
    page.getByRole('button', { name: 'Unmute Grace · microphone' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('audio')
        .first()
        .evaluate(
          (audio: HTMLAudioElement, expected) =>
            Math.abs(audio.currentTime - expected),
          timeBeforeFullscreen,
        ),
    )
    .toBeLessThan(0.05);
  await page.screenshot({ path: '.local/recording-player-fullscreen.png' });
  await page.getByRole('button', { name: 'Exit fullscreen' }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement))
    .toBeNull();

  await page
    .locator('.recording-player__stage')
    .dblclick({ position: { x: 20, y: 20 } });
  await expect(
    page.getByRole('button', { name: 'Exit fullscreen' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Exit fullscreen' }).click();
  await expect(
    page.getByRole('button', { name: 'Enter fullscreen' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Recording playback' }),
  ).toBeVisible();

  const player = page.getByRole('region', { name: 'Recording playback' });
  await player.evaluate((element) =>
    Object.defineProperty(element, 'requestFullscreen', {
      configurable: true,
      value: undefined,
    }),
  );
  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Fullscreen playback is not supported in this window.',
  );
  await player.evaluate((element) => delete element.requestFullscreen);

  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('audio')
        .evaluateAll((elements: HTMLAudioElement[]) =>
          elements.map((element) => element.currentTime),
        ),
    )
    .toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
  await page.waitForTimeout(750);
  const playbackTimes = await page
    .locator('audio')
    .evaluateAll((elements: HTMLAudioElement[]) =>
      elements.map((element) => element.currentTime),
    );
  expect(playbackTimes[0]).toBeGreaterThan(0.35);
  expect(playbackTimes[1]).toBeGreaterThan(0.05);
  expect(playbackTimes[1]).toBeLessThan(playbackTimes[0]);

  const timeline = page.getByRole('slider', { name: 'Recording timeline' });
  await timeline.evaluate((input: HTMLInputElement) => {
    input.value = '1100';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect
    .poll(async () => Number(await timeline.inputValue()))
    .toBeGreaterThanOrEqual(1_090);
  await expect
    .poll(() =>
      page
        .locator('audio')
        .first()
        .evaluate((audio: HTMLAudioElement) => audio.currentTime),
    )
    .toBeGreaterThan(0.9);

  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: /All recordings/ }).click();
  await page.getByRole('button', { name: `Delete ${recordingTitle}` }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(
    page.locator('.library-open').filter({ hasText: recordingTitle }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Recordings', exact: true }).click();
  await expect(
    page.locator('.library-open').filter({ hasText: recordingTitle }),
  ).toHaveCount(0);
});
