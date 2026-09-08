import { expect, test } from '@playwright/test';

test('capture ownership stops user media and couples screen with system audio', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { MediaEngine } = await import('/src/media/index.ts');
    const engine = new MediaEngine({
      signaling: { localPeerId: 'lifecycle-test', send() {} },
      // Screen capture constraints must follow the configured stream quality.
      quality: { maxFramerate: 120 },
    });
    const audioContext = new AudioContext();
    const audioDestination = audioContext.createMediaStreamDestination();
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const videoTrack = canvas.captureStream(5).getVideoTracks()[0]!;
    const microphone = audioDestination.stream.getAudioTracks()[0]!.clone();
    const system = audioDestination.stream.getAudioTracks()[0]!.clone();
    const camera = videoTrack.clone();
    let requestedCapture: unknown;

    const originalUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    const originalDisplayMedia = navigator.mediaDevices.getDisplayMedia?.bind(
      navigator.mediaDevices,
    );
    Object.defineProperties(navigator.mediaDevices, {
      getUserMedia: {
        configurable: true,
        value: async () => new MediaStream([camera, microphone]),
      },
      getDisplayMedia: {
        configurable: true,
        value: async (options: unknown) => {
          requestedCapture = options;
          return new MediaStream([videoTrack, system]);
        },
      },
    });

    try {
      await engine.captureUserMedia({ camera: true, microphone: true });
      await engine.captureScreen({ systemAudio: true });
      // Chromium trades resolution away first without an explicit hint, which is
      // the wrong degradation for a screen full of text.
      const screenContentHint = videoTrack.contentHint;
      videoTrack.stop();
      // MediaStreamTrack.stop() itself does not emit ended; browsers emit it when
      // the display source ends through the picker/browser chrome.
      videoTrack.dispatchEvent(new Event('ended'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const shareRemoved =
        !engine.getLocalTracks().has('screen') &&
        !engine.getLocalTracks().has('system');
      const systemStopped = system.readyState === 'ended';
      engine.dispose();
      return {
        shareRemoved,
        requestedCapture,
        screenContentHint,
        systemStopped,
        cameraStopped: camera.readyState === 'ended',
        microphoneStopped: microphone.readyState === 'ended',
      };
    } finally {
      Object.defineProperties(navigator.mediaDevices, {
        getUserMedia: { configurable: true, value: originalUserMedia },
        getDisplayMedia: { configurable: true, value: originalDisplayMedia },
      });
      videoTrack.stop();
      microphone.stop();
      system.stop();
      camera.stop();
      await audioContext.close();
    }
  });

  expect(result).toEqual({
    shareRemoved: true,
    requestedCapture: {
      video: {
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        frameRate: { ideal: 120, max: 120 },
      },
      audio: true,
      windowAudio: 'window',
    },
    screenContentHint: 'detail',
    systemStopped: true,
    cameraStopped: true,
    microphoneStopped: true,
  });
});

test('canceled browser chooser discards late tracks without replacing a newer share', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { MediaEngine } = await import('/src/media/index.ts');
    const engine = new MediaEngine({
      signaling: { localPeerId: 'canceled-chooser', send() {} },
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const newer = canvas.captureStream(5).getVideoTracks()[0]!;
    const late = newer.clone();
    const original = navigator.mediaDevices.getDisplayMedia;
    let resolve!: (stream: MediaStream) => void;
    let current = true;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: () =>
        new Promise<MediaStream>((r) => {
          resolve = r;
        }),
    });
    try {
      const pending = engine
        .captureScreen({}, () => current)
        .catch((error) => error.name);
      current = false;
      await engine.setLocalTrack('screen', newer);
      resolve(new MediaStream([late]));
      const error = await pending;
      return {
        error,
        lateStopped: late.readyState === 'ended',
        newerLive: newer.readyState === 'live',
        newerPreserved: engine.getLocalTracks().get('screen') === newer,
      };
    } finally {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: original,
      });
      engine.dispose();
      late.stop();
      newer.stop();
    }
  });
  expect(result).toEqual({
    error: 'AbortError',
    lateStopped: true,
    newerLive: true,
    newerPreserved: true,
  });
});
