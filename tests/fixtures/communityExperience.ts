import { expect, type Page } from '@playwright/test';

/** Call controls reveal on pointer movement and hide after inactivity. */
export async function revealCallControls(page: Page) {
  const stage = page
    .getByRole('main', { name: 'Call', exact: true })
    .locator('.call-workspace');
  await stage.hover({ position: { x: 24, y: 24 } });
  await stage.hover({ position: { x: 48, y: 48 } });
  await expect(stage).toHaveAttribute('data-controls-visible', 'true');
}

/** A complete two-page PDF with real xref offsets; each page paints a solid color. */
export function coloredPDFFixture(): Buffer {
  const blue = '0.1 0.35 0.75 rg\n0 0 240 160 re f\n';
  const red = '0.75 0.2 0.1 rg\n0 0 240 160 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(blue)} >>\nstream\n${blue}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(red)} >>\nstream\n${red}endstream`,
  ];
  let body = '%PDF-1.4\n%Bettercomms synthetic acceptance fixture\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

export interface SyntheticCaptureState {
  inputs: MediaStreamTrack[];
  inputContexts: AudioContext[];
  recorders: MediaRecorder[];
  clones: { source: string; kind: string }[];
  cleanup: () => Promise<void>;
}
export type SyntheticCaptureWindow = Window & {
  __communityCapture: SyntheticCaptureState;
};

/** Install before navigation. All clips still use the application's real codecs,
 * recorder, editor, API and storage; only browser device capture is synthetic. */
export function installSyntheticCapture() {
  const state: SyntheticCaptureState = {
    inputs: [],
    inputContexts: [],
    recorders: [],
    clones: [],
    cleanup: async () => {},
  };
  Object.defineProperty(window, '__communityCapture', { value: state });
  localStorage.setItem('bc-noise', 'off');
  localStorage.setItem('bc-denoiser', 'off');
  localStorage.setItem(
    'bc-processing',
    JSON.stringify({
      echoCancellation: false,
      autoGainControl: false,
      highPassHz: 0,
      gainDb: 0,
      inputVolume: 1,
      gateEnabled: false,
    }),
  );
  localStorage.setItem(
    'bc-push-to-talk',
    JSON.stringify({
      enabled: false,
      binding: { kind: 'keyboard', code: 'Space' },
    }),
  );

  const clone = MediaStreamTrack.prototype.clone;
  MediaStreamTrack.prototype.clone = function () {
    state.clones.push({ source: this.id, kind: this.kind });
    return clone.call(this);
  };
  const Recorder = window.MediaRecorder;
  window.MediaRecorder = class extends Recorder {
    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      super(stream, options);
      state.recorders.push(this);
    }
  };

  let audio: MediaStreamTrack | undefined;
  const cleanups = new Set<() => void>();
  function microphone() {
    if (audio?.readyState === 'live') return audio;
    const context = new AudioContext({ sampleRate: 48000 });
    state.inputContexts.push(context);
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 440;
    const gain = context.createGain();
    gain.gain.value = 0.18;
    const output = context.createMediaStreamDestination();
    oscillator.connect(gain).connect(output);
    oscillator.start();
    const track = output.stream.getAudioTracks()[0]!;
    const stop = track.stop.bind(track);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      stop();
      oscillator.stop();
      oscillator.disconnect();
      gain.disconnect();
      output.disconnect();
      void context.close();
      cleanups.delete(release);
    };
    track.stop = release;
    state.inputs.push(track);
    cleanups.add(release);
    audio = track;
    void context.resume();
    return track;
  }
  // The first UI gesture resumes the fixture clock before Join makes an API call.
  microphone();
  const resume = () => {
    for (const context of state.inputContexts)
      if (context.state === 'suspended') void context.resume();
  };
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);

  function camera() {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const drawing = canvas.getContext('2d')!;
    let frame = 0;
    const paint = () => {
      drawing.fillStyle = frame++ % 2 ? '#41b28a' : '#527acd';
      drawing.fillRect(0, 0, canvas.width, canvas.height);
    };
    paint();
    const timer = setInterval(paint, 33);
    const track = canvas.captureStream(30).getVideoTracks()[0]!;
    const stop = track.stop.bind(track);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      stop();
      cleanups.delete(release);
    };
    track.stop = release;
    state.inputs.push(track);
    cleanups.add(release);
    return track;
  }
  // Headless WebKit omits OS capture APIs. The fixture supplies synthetic device
  // discovery; encoding, playback and track lifecycle still use the real engine.
  if (!navigator.mediaDevices)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
        getSupportedConstraints: () => ({}),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value: async (constraints: MediaStreamConstraints) => {
      const tracks: MediaStreamTrack[] = [];
      if (constraints.audio) {
        const track = microphone();
        await state.inputContexts.at(-1)!.resume();
        tracks.push(track);
      }
      if (constraints.video) tracks.push(camera());
      return new MediaStream(tracks);
    },
  });
  state.cleanup = async () => {
    window.removeEventListener('pointerdown', resume);
    window.removeEventListener('keydown', resume);
    for (const release of [...cleanups]) release();
    await Promise.all(
      state.inputContexts.map((context) =>
        context.state === 'closed' ? Promise.resolve() : context.close(),
      ),
    );
  };
  window.addEventListener(
    'pagehide',
    () => {
      void state.cleanup();
    },
    { once: true },
  );
}
