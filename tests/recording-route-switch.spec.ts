import { expect, test } from '@playwright/test';

test('recording resumes a returning microphone as a distinct timed segment', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { TrackRecordingSession } = await import('/src/media/recording.ts');
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const output = context.createMediaStreamDestination();
    oscillator.connect(analyser).connect(output);
    oscillator.start();
    const track = output.stream.getAudioTracks()[0]!;
    const descriptor = {
      peerId: 'friend',
      source: 'microphone' as const,
      track,
    };
    const session = new TrackRecordingSession();
    const waitForAudio = async (ready: () => boolean, label: string) => {
      const deadline = performance.now() + 5000;
      while (!ready()) {
        if (performance.now() >= deadline)
          throw new Error(
            `${label}: context=${context.state}, audioClock=${context.currentTime}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const samples = new Float32Array(analyser.fftSize);
    const sourceRms = () => {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(
        samples.reduce((sum, sample) => sum + sample * sample, 0) /
          samples.length,
      );
    };
    try {
      await context.resume();
      // resume() can resolve before the audio device begins rendering samples.
      await waitForAudio(
        () => context.currentTime >= 0.1 && sourceRms() > 0.05,
        'Synthetic microphone did not start',
      );
      session.start([descriptor]);
      let started = context.currentTime;
      await waitForAudio(
        () => context.currentTime - started >= 0.25,
        'First segment audio clock stalled',
      );
      session.removeTrack(track.id);
      const removed = context.currentTime;
      await waitForAudio(
        () => context.currentTime - removed >= 0.1,
        'Microphone gap audio clock stalled',
      );
      session.addTrack(descriptor);
      session.addTrack(descriptor);
      started = context.currentTime;
      await waitForAudio(
        () => context.currentTime - started >= 0.25,
        'Returning segment audio clock stalled',
      );
      session.removeTrack(track.id);
      // stop() must await final data even when removeTrack() already changed
      // the MediaRecorder state to inactive; no flush sleep hides that race.
      const recording = await session.stop();
      return recording.manifest.tracks;
    } finally {
      await session.stop();
      track.stop();
      oscillator.stop();
      await context.close();
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
