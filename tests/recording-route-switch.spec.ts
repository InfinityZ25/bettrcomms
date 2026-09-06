import { expect, test } from '@playwright/test';

test('recording resumes a returning microphone as a distinct timed segment', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { TrackRecordingSession } = await import('/src/media/recording.ts');
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const output = context.createMediaStreamDestination();
    oscillator.connect(output);
    oscillator.start();
    await context.resume();
    const track = output.stream.getAudioTracks()[0]!;
    const descriptor = { peerId: 'friend', source: 'microphone' as const, track };
    const session = new TrackRecordingSession();
    try {
      session.start([descriptor]);
      await new Promise(resolve => setTimeout(resolve, 250));
      session.removeTrack(track.id);
      await new Promise(resolve => setTimeout(resolve, 100));
      session.addTrack(descriptor);
      session.addTrack(descriptor);
      await new Promise(resolve => setTimeout(resolve, 250));
      session.removeTrack(track.id);
      await new Promise(resolve => setTimeout(resolve, 100));
      const recording = await session.stop();
      return recording.manifest.tracks;
    } finally {
      await session.stop();
      track.stop(); oscillator.stop(); await context.close();
    }
  });
  expect(result).toHaveLength(2);
  expect(result[0]!.id).not.toBe(result[1]!.id);
  expect(result[1]!.startedOffsetMs).toBeGreaterThan(result[0]!.durationMs);
  for (const segment of result) {
    expect(segment.bytes).toBeGreaterThan(100);
    expect(segment.status).toBe('complete');
    expect(segment.endedReason).toBe('track-ended');
    expect(segment.durationMs).toBeGreaterThan(150);
  }
});
