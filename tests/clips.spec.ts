import { expect, test } from '@playwright/test';
import { revealCallControls } from './fixtures/communityExperience';

test('rolling source segments export a trimmed playable clip with video and independent audio', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { ClipBuffer } = await import('/src/media/clipBuffer.ts');
    const { renderClip, clipTrackKey } =
      await import('/src/media/clipRenderer.ts');
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const drawing = canvas.getContext('2d')!;
    let frame = 0;
    const paint = setInterval(() => {
      drawing.fillStyle = frame++ % 2 ? '#64cfa4' : '#5d8ae7';
      drawing.fillRect(0, 0, 320, 180);
    }, 30);
    const stream = canvas.captureStream(30);
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 440;
    const gain = context.createGain();
    gain.gain.value = 0.15;
    const source = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(source);
    oscillator.start();
    const buffer = new ClipBuffer({ segmentMs: 1000, windowMs: 90_000 });
    const wait = async (predicate: () => boolean) => {
      const deadline = performance.now() + 10_000;
      while (!predicate()) {
        if (performance.now() > deadline)
          throw new Error('Clip media timed out');
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    let video: HTMLVideoElement | undefined;
    let url: string | undefined;
    try {
      await context.resume();
      await wait(() => context.currentTime > 0.15);
      buffer.reconcile([
        {
          peerId: 'friend',
          source: 'screen',
          track: stream.getVideoTracks()[0]!,
        },
        {
          peerId: 'friend',
          source: 'microphone',
          track: source.stream.getAudioTracks()[0]!,
        },
      ]);
      const origin = context.currentTime;
      await wait(() => context.currentTime - origin >= 3.5);
      const window = await buffer.snapshot();
      const sources = [
        ...new Set(window.segments.map((segment) => segment.source)),
      ];
      const controller = new AbortController();
      const blob = await renderClip({
        window,
        startMs: window.startMs + 600,
        endMs: window.startMs + 2800,
        videoKey: clipTrackKey(
          window.segments.find((segment) => segment.source === 'screen')!,
        ),
        audioKeys: ['friend:microphone'],
        title: 'Captured moment',
        signal: controller.signal,
      });
      if (!blob) throw new Error('No encoded clip');
      video = document.createElement('video');
      video.preload = 'auto';
      url = URL.createObjectURL(blob);
      video.src = url;
      video.load();
      await wait(() => video!.readyState >= 1);
      if (!Number.isFinite(video.duration)) {
        video.currentTime = 1e8;
        await wait(() => Number.isFinite(video!.duration));
      }
      const duration = video.duration;
      video.currentTime = 0;
      await wait(() => video!.readyState >= 2 && !video!.seeking);
      const decoded = context.createMediaElementSource(video);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const silence = context.createGain();
      silence.gain.value = 0;
      decoded.connect(analyser).connect(silence).connect(context.destination);
      await video.play();
      const samples = new Float32Array(analyser.fftSize);
      let rms = 0;
      await wait(() => {
        analyser.getFloatTimeDomainData(samples);
        rms = Math.sqrt(
          samples.reduce((sum, value) => sum + value * value, 0) /
            samples.length,
        );
        return rms > 0.015;
      });
      const output = document.createElement('canvas');
      output.width = 1280;
      output.height = 720;
      const pixels = output.getContext('2d')!;
      pixels.drawImage(video, 0, 0);
      const pixel = [...pixels.getImageData(640, 360, 1, 1).data];
      await buffer.dispose();
      return {
        sources,
        segments: window.segments.length,
        duration,
        bytes: blob.size,
        width: video.videoWidth,
        height: video.videoHeight,
        pixel,
        rms,
        originalLive:
          stream.getVideoTracks()[0]!.readyState === 'live' &&
          source.stream.getAudioTracks()[0]!.readyState === 'live',
        retained: buffer.retainedBytes,
      };
    } finally {
      await buffer.dispose();
      clearInterval(paint);
      video?.pause();
      video?.removeAttribute('src');
      video?.load();
      if (url) URL.revokeObjectURL(url);
      oscillator.stop();
      for (const track of [...stream.getTracks(), ...source.stream.getTracks()])
        track.stop();
      await context.close();
    }
  });
  expect(result.sources.sort()).toEqual(['microphone', 'screen']);
  expect(result.segments).toBeGreaterThanOrEqual(6);
  expect(result.duration).toBeGreaterThan(1.7);
  expect(result.duration).toBeLessThan(3.2);
  expect(result.bytes).toBeGreaterThan(1000);
  expect([result.width, result.height]).toEqual([1280, 720]);
  expect(result.pixel.slice(0, 3).some((value) => value > 80)).toBe(true);
  expect(result.rms).toBeGreaterThan(0.015);
  expect(result.originalLive).toBe(true);
  expect(result.retained).toBe(0);
});

test('a call clip can be previewed, titled, published and opened from its channel', async ({
  page,
  context,
}) => {
  const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
  const headers = { Origin: new URL(base).origin };
  const suffix = Date.now();
  const login = await context.request.post('/api/v1/auth/dev', {
    headers,
    data: { name: 'Clip owner', email: `clip-owner-${suffix}@example.test` },
  });
  expect(login.ok()).toBe(true);
  const response = await context.request.post('/api/v1/communities', {
    headers,
    data: { name: `Clip room ${suffix}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { community } = await response.json();
  const room = community.channels[0];
  try {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Rooms', exact: true })
      .click();
    await page
      .getByRole('list', { name: `${community.name} channel list` })
      .getByRole('button', { name: room.name, exact: true })
      .click();
    await page.getByRole('button', { name: 'Join voice', exact: true }).click();
    await page
      .getByRole('button', { name: 'Enable clip buffer', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Capture moments with clips' })
      .getByRole('button', { name: 'Enable clip buffer', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Create clip', exact: true }),
    ).toBeEnabled();
    await revealCallControls(page);
    await page
      .getByRole('button', { name: 'Create clip', exact: true })
      .click();
    const editor = page.getByRole('dialog', {
      name: 'Create clip',
      exact: true,
    });
    await expect(editor).toBeVisible();
    await editor
      .getByLabel('Clip title', { exact: true })
      .fill(`A great moment ${suffix}`);
    await editor.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(
      editor.getByRole('button', { name: 'Publish clip', exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await editor
      .getByRole('button', { name: 'Publish clip', exact: true })
      .click();
    await expect(editor).not.toBeVisible({ timeout: 30_000 });
    const history = await context.request.get(
      `/api/v1/rooms/${room.id}/messages`,
    );
    expect(history.ok()).toBe(true);
    const { messages } = await history.json();
    const clip = messages.find((item: { body: string }) =>
      item.body.includes(`A great moment ${suffix}`),
    );
    expect(clip.attachments).toHaveLength(1);
    expect(clip.attachments[0].content_type).toMatch(/^video\//);
    const download = await context.request.get(
      `/api/v1/rooms/${room.id}/attachments/${clip.attachments[0].id}`,
    );
    expect(download.ok()).toBe(true);
    await revealCallControls(page);
    await page
      .getByRole('button', { name: 'Stop clip buffer', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Enable clip buffer', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Leave call', exact: true }).click();
  } finally {
    await context.request.delete(`/api/v1/communities/${community.id}`, {
      headers,
    });
  }
});
