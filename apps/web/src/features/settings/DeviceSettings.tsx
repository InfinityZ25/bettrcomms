import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { applyOutputDevice, followElementOutput, followOutputDevice } from '@/media/output';
import {
  createOutputGain,
  readInputVolume,
  readOutputVolume,
  setInputVolume,
  setOutputVolume,
} from '@/media/volumeSettings';
import './DeviceSettings.css';
import { MediaEngine } from '@/media/engine';
import { allowDesktopCapture, isWindowsDesktop } from '@/media/permissions';
import {
  microphoneCaptureOptions,
  readProcessingSettings,
} from '@/media/processingSettings';
import {
  cameraCaptureConstraints,
  cameraFrameRates,
  cameraFrameRateSupported,
  cameraResolutions,
  cameraResolutionSupported,
  readCameraSettings,
  requestedCameraLabel,
  writeCameraSettings,
  type CameraSettings,
} from '@/media/cameraSettings';

type PermissionKind = 'microphone' | 'camera';
const message = (error: unknown, kind?: PermissionKind) => {
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  )
    return `${kind === 'camera' ? 'Camera' : 'Microphone'} access was denied. Allow it in your browser or system privacy settings, then try again.`;
  return error instanceof Error ? error.message : String(error);
};

async function ensureDesktopPermission(kind: PermissionKind) {
  await allowDesktopCapture(kind);
}

function closeContext(context: AudioContext | null) {
  if (context && context.state !== 'closed')
    void context.close().catch(() => {});
}

export default function DeviceSettings() {
  const [windowsDesktop, setWindowsDesktop] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [input, setInput] = useState(localStorage.getItem('bc-input') ?? '');
  const [camera, setCamera] = useState(localStorage.getItem('bc-camera') ?? '');
  const [cameraQuality, setCameraQuality] = useState(readCameraSettings);
  const [cameraCapabilities, setCameraCapabilities] =
    useState<MediaTrackCapabilities | null>(null);
  const [cameraActual, setCameraActual] = useState<MediaTrackSettings | null>(
    null,
  );
  const [output, setOutput] = useState(localStorage.getItem('bc-output') ?? '');
  const [inputVolume, setInputVolumeState] = useState(readInputVolume);
  const [outputVolume, setOutputVolumeState] = useState(readOutputVolume);
  const [micStatus, setMicStatus] = useState('');
  const [cameraStatus, setCameraStatus] = useState('');
  const [outputStatus, setOutputStatus] = useState('');
  const [level, setLevel] = useState(0);
  const [micLevels, setMicLevels] = useState<{
    input: number;
    processed: number;
    inputPeak: number;
    processedPeak: number;
  } | null>(null);
  const micDiagnostic = useRef<Record<string, unknown> | null>(null);
  const [diagnosticStatus, setDiagnosticStatus] = useState('');
  const inputMeterCleanup = useRef<(() => void) | null>(null);
  const [recording, setRecording] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const [monitorVolume, setMonitorVolume] = useState(0.5);
  const monitorVolumeRef = useRef(0.5);
  const monitorGain = useRef<GainNode | null>(null);
  const monitorCleanup = useRef<(() => void) | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const testEngine = useRef<MediaEngine | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    void isWindowsDesktop().then(setWindowsDesktop);
  }, []);
  const animation = useRef<number | null>(null);
  const playback = useRef<HTMLAudioElement | null>(null);
  const playbackOutputCleanup = useRef<(() => void) | null>(null);
  const outputContext = useRef<AudioContext | null>(null);
  const blobUrl = useRef<string | null>(null);
  const alive = useRef(true);
  const micRequest = useRef(0);
  const cameraRequest = useRef(0);
  const playbackRequest = useRef(0);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices) return;
    setDevices(await navigator.mediaDevices.enumerateDevices());
  }, []);
  const stopMic = useCallback(() => {
    micRequest.current += 1;
    inputMeterCleanup.current?.();
    inputMeterCleanup.current = null;
    monitorCleanup.current?.();
    monitorCleanup.current = null;
    monitorGain.current = null;
    setMonitoring(false);
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    timer.current = animation.current = null;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    testEngine.current?.dispose();
    testEngine.current = null;
    micStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current = null;
    closeContext(audioContext.current);
    audioContext.current = null;
    setLevel(0);
    setRecording(false);
  }, []);
  const stopPlayback = useCallback(() => {
    playbackRequest.current += 1;
    playbackOutputCleanup.current?.();
    playbackOutputCleanup.current = null;
    if (playback.current) {
      playback.current.pause();
      playback.current.removeAttribute('src');
      playback.current.load();
    }
    playback.current = null;
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = null;
  }, []);
  const stopCamera = useCallback(() => {
    cameraRequest.current += 1;
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setPreviewing(false);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh().catch(() => {});
    const changed = () => void refresh().catch(() => {});
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    return () => {
      alive.current = false;
      navigator.mediaDevices?.removeEventListener('devicechange', changed);
      stopMic();
      stopPlayback();
      stopCamera();
      closeContext(outputContext.current);
      outputContext.current = null;
    };
  }, [refresh, stopCamera, stopMic, stopPlayback]);

  useEffect(() => {
    const changed = () => {
      const hadTest = Boolean(testEngine.current || playback.current);
      stopMic();
      stopPlayback();
      if (hadTest)
        setMicStatus(
          'Processing settings changed. Run a new microphone test to hear them.',
        );
    };
    for (const event of ['bc-processing', 'bc-denoiser', 'bc-noise'])
      window.addEventListener(event, changed);
    return () => {
      for (const event of ['bc-processing', 'bc-denoiser', 'bc-noise'])
        window.removeEventListener(event, changed);
    };
  }, [stopMic, stopPlayback]);

  async function enable(kind: PermissionKind) {
    const setStatus = kind === 'camera' ? setCameraStatus : setMicStatus;
    if (kind === 'camera') stopCamera();
    else {
      stopMic();
      stopPlayback();
    }
    const request =
      kind === 'camera' ? ++cameraRequest.current : ++micRequest.current;
    setStatus('');
    try {
      await ensureDesktopPermission(kind);
      if (
        !alive.current ||
        request !==
          (kind === 'camera' ? cameraRequest.current : micRequest.current)
      )
        return;
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === 'camera' ? { video: true } : { audio: true },
      );
      if (
        !alive.current ||
        request !==
          (kind === 'camera' ? cameraRequest.current : micRequest.current)
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.getTracks().forEach((track) => track.stop());
      await refresh();
      if (
        alive.current &&
        request ===
          (kind === 'camera' ? cameraRequest.current : micRequest.current)
      )
        setStatus(
          `${kind === 'camera' ? 'Camera' : 'Microphone'} access enabled. Device names refreshed.`,
        );
    } catch (error) {
      if (
        alive.current &&
        request ===
          (kind === 'camera' ? cameraRequest.current : micRequest.current)
      )
        setStatus(message(error, kind));
    }
  }

  async function testMicrophone(mode: 'sample' | 'live' = 'sample') {
    stopMic();
    stopPlayback();
    setMicLevels(null);
    micDiagnostic.current = null;
    setDiagnosticStatus('');
    setMicStatus(mode === 'live' ? 'Starting live loopback…' : '');
    setMonitoring(mode === 'live');
    const request = ++micRequest.current;
    try {
      await ensureDesktopPermission('microphone');
      if (!alive.current || request !== micRequest.current) return;
      const settings = readProcessingSettings();
      let activeEngine = settings.engine;
      let engineNotice = '';
      const engineLabel = () =>
        ({
          standard: 'Browser',
          rnnoise: 'RNNoise',
          speex: 'Speex',
          nvidia: 'NVIDIA',
          deepfilter: 'DeepFilterNet',
          off: 'Suppression off',
        })[activeEngine];
      const liveStatus = () =>
        `Live loopback · ${engineLabel()} · 1-second delay.${engineNotice ? ' ' + engineNotice : ''}`;
      const capture = new MediaEngine({
        signaling: { localPeerId: 'microphone-test', send() {} },
      });
      testEngine.current = capture;
      capture.addEventListener('denoiser-status', (event) => {
        if (!alive.current || request !== micRequest.current) return;
        activeEngine = event.detail.active;
        engineNotice = event.detail.message;
        if (mode === 'live' && monitorCleanup.current) {
          setMicStatus(liveStatus());
        } else if (recorder.current) {
          stopMic();
          stopPlayback();
          setMicStatus(
            event.detail.message + ' Run the microphone test again.',
          );
        }
      });
      capture.addEventListener('error', (event) => {
        if (!alive.current || request !== micRequest.current) return;
        stopMic();
        stopPlayback();
        setMicStatus(message(event.detail.error));
      });
      const options = microphoneCaptureOptions(input);
      // Monitoring intentionally plays the user's own voice. Echo cancellation
      // can learn that playback as echo and suppress sustained speech.
      // Keep call/sample preferences intact; only headphone monitoring opts out.
      if (mode === 'live') options.echoCancellation = false;
      await capture.captureUserMedia(options);
      const track = capture.getLocalTracks().get('microphone');
      if (!track) throw new Error('The microphone test did not produce audio.');
      const stream = new MediaStream([track]);
      const engineName = engineLabel();
      if (!alive.current || request !== micRequest.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      micStream.current = stream;
      const context = new AudioContext();
      audioContext.current = context;
      if (mode === 'live') await applyOutputDevice(context);
      if (!alive.current || request !== micRequest.current) {
        closeContext(context);
        return;
      }
      await context.resume();
      if (!alive.current || request !== micRequest.current) {
        stream.getTracks().forEach((track) => track.stop());
        closeContext(context);
        return;
      }
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      // Processing may have fallen back while output routing was awaiting.
      const currentTrack = capture.getLocalTracks().get('microphone');
      if (!currentTrack || currentTrack.readyState === 'ended')
        throw new Error('The microphone stopped during test startup.');
      const currentStream = new MediaStream([currentTrack]);
      micStream.current = currentStream;
      let source = context.createMediaStreamSource(currentStream);
      source.connect(analyser);
      const rawTrack = capture.getMicrophoneInput();
      const rawAnalyser = context.createAnalyser();
      rawAnalyser.fftSize = 1024;
      const rawSource = rawTrack
        ? context.createMediaStreamSource(new MediaStream([rawTrack]))
        : null;
      rawSource?.connect(rawAnalyser);
      const rawSettings = rawTrack?.getSettings() ?? {};
      const channelCount = Math.min(8, Math.max(1, rawSettings.channelCount ?? 1));
      const splitter = context.createChannelSplitter(channelCount);
      const channelMeters = Array.from({ length: channelCount }, (_, channel) => {
        const meter = context.createAnalyser();
        meter.fftSize = 1024;
        splitter.connect(meter, channel);
        return { meter, samples: new Float32Array(meter.fftSize), peak: -120 };
      });
      rawSource?.connect(splitter);
      inputMeterCleanup.current = () => {
        rawSource?.disconnect();
        rawAnalyser.disconnect();
        splitter.disconnect();
        channelMeters.forEach(({ meter }) => meter.disconnect());
      };
      const format = ({
        channelCount,
        sampleRate,
        sampleSize,
        autoGainControl,
        echoCancellation,
        noiseSuppression,
      }: MediaTrackSettings) => ({
        channelCount,
        sampleRate,
        sampleSize,
        autoGainControl,
        echoCancellation,
        noiseSuppression,
      });
      const values = new Float32Array(analyser.fftSize);
      const rawValues = new Float32Array(rawAnalyser.fftSize);
      let lastMeterUpdate = 0,
        inputPeak = -120,
        processedPeak = -120;
      const db = (samples: Float32Array) =>
        Math.max(
          -120,
          20 *
            Math.log10(
              Math.sqrt(
                samples.reduce((sum, value) => sum + value * value, 0) /
                  samples.length,
              ) || 1e-6,
            ),
        );
      const draw = () => {
        analyser.getFloatTimeDomainData(values);
        rawAnalyser.getFloatTimeDomainData(rawValues);
        const processed = db(values),
          raw = db(rawValues);
        inputPeak = Math.max(inputPeak, raw);
        processedPeak = Math.max(processedPeak, processed);
        const now = performance.now();
        if (now - lastMeterUpdate >= 100) {
          lastMeterUpdate = now;
          const inputChannels = channelMeters.map(entry => {
            entry.meter.getFloatTimeDomainData(entry.samples);
            const current = db(entry.samples);
            entry.peak = Math.max(entry.peak, current);
            return { current, peak: entry.peak };
          });
          setLevel(Math.max(0, Math.min(100, ((processed + 72) / 72) * 100)));
          const levels = { input: raw, processed, inputPeak, processedPeak };
          setMicLevels(levels);
          micDiagnostic.current = {
            version: 1,
            runtime: windowsDesktop ? 'windows-webview' : 'browser',
            test: mode,
            inputAvailable: Boolean(rawTrack),
            browserVersion: navigator.userAgent.match(
              /(?:Chrome|Edg)\/[\d.]+/g,
            ),
            requestedProcessing: {
              ...settings,
              echoCancellation:
                options.echoCancellation ?? settings.echoCancellation,
            },
            activeEngine: engineLabel(),
            // Read the current processed track so a denoiser fallback is reflected.
            inputFormat: format(rawSettings),
            processedFormat: format(
              capture.getLocalTracks().get('microphone')?.getSettings() ?? {},
            ),
            levelsDbfs: levels,
            inputChannelsDbfs: inputChannels,
          };
        }
        animation.current = requestAnimationFrame(draw);
      };
      draw();
      if (mode === 'live') {
        const delay = context.createDelay(1.1);
        delay.delayTime.value = 1;
        const gain = context.createGain();
        const master = createOutputGain(context);
        gain.gain.value = monitorVolumeRef.current;
        monitorGain.current = gain;
        analyser.connect(delay).connect(gain).connect(master.gain).connect(context.destination);
        const failed = (error: Error) => {
          if (!alive.current || request !== micRequest.current) return;
          stopMic();
          setMicStatus(error.message);
        };
        const stopOutput = followOutputDevice(context, failed);
        const replaced = (
          event: CustomEvent<{
            source: string;
            track: MediaStreamTrack | null;
          }>,
        ) => {
          if (
            event.detail.source !== 'microphone' ||
            !alive.current ||
            request !== micRequest.current
          )
            return;
          const next = event.detail.track;
          if (!next) {
            failed(
              new Error(
                'Microphone disconnected. Start live loopback again after reconnecting it.',
              ),
            );
            return;
          }
          // Preserve the delay's timeline and buffered audio across a denoiser
          // fallback. A source replacement must not restart the whole test.
          try {
            const nextStream = new MediaStream([next]);
            const nextSource = context.createMediaStreamSource(nextStream);
            source.disconnect();
            source = nextSource;
            source.connect(analyser);
            micStream.current = nextStream;
          } catch (error) {
            failed(error instanceof Error ? error : new Error(String(error)));
          }
        };
        capture.addEventListener('local-track', replaced);
        monitorCleanup.current = () => {
          stopOutput();
          capture.removeEventListener('local-track', replaced as EventListener);
          source.disconnect();
          analyser.disconnect();
          delay.disconnect();
          gain.disconnect();
          master.dispose();
        };
        setMicStatus(liveStatus());
        await refresh();
        return;
      }
      const chunks: Blob[] = [];
      const activeRecorder = new MediaRecorder(currentStream);
      recorder.current = activeRecorder;
      activeRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      activeRecorder.onstop = async () => {
        const shouldPlay = request === micRequest.current;
        if (!shouldPlay || !alive.current) return;
        stopMic();
        const url = URL.createObjectURL(
          new Blob(chunks, { type: activeRecorder.mimeType }),
        );
        blobUrl.current = url;
        const audio = new Audio(url);
        playback.current = audio;
        const playbackId = ++playbackRequest.current;
        try {
          playbackOutputCleanup.current = followElementOutput(audio, (error: Error) => {
            if (alive.current && playback.current === audio)
              setMicStatus(message(error));
          });
          if (
            !alive.current ||
            playbackId !== playbackRequest.current ||
            playback.current !== audio
          )
            return;
          await audio.play();
          if (alive.current && playback.current === audio)
            setMicStatus(
              `Playing your 5-second ${engineName} microphone sample.${engineNotice ? ' ' + engineNotice : ''}`,
            );
        } catch (error) {
          if (alive.current && playback.current === audio)
            setMicStatus(message(error));
        }
        audio.onended = stopPlayback;
      };
      activeRecorder.start();
      setRecording(true);
      setMicStatus(
        `Recording a 5-second ${engineName} sample…${engineNotice ? ' ' + engineNotice : ''}`,
      );
      timer.current = window.setTimeout(() => {
        if (activeRecorder.state === 'recording') activeRecorder.stop();
      }, 5000);
      await refresh();
    } catch (error) {
      if (request === micRequest.current) {
        stopMic();
        if (alive.current) setMicStatus(message(error, 'microphone'));
      }
    }
  }

  async function startCameraPreview(settings: CameraSettings = cameraQuality) {
    stopCamera();
    setCameraStatus(`Starting ${requestedCameraLabel(settings)} preview…`);
    const request = ++cameraRequest.current;
    try {
      await ensureDesktopPermission('camera');
      if (!alive.current || request !== cameraRequest.current) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: cameraCaptureConstraints(camera, settings),
        audio: false,
      });
      if (!alive.current || request !== cameraRequest.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStream.current = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('The camera preview did not produce video.');
      setCameraActual(track.getSettings());
      setCameraCapabilities(
        typeof track.getCapabilities === 'function'
          ? track.getCapabilities()
          : null,
      );
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if (!alive.current || request !== cameraRequest.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setPreviewing(true);
      const actual = track.getSettings();
      const actualLabel =
        actual.width && actual.height
          ? `${actual.width}×${actual.height}${actual.frameRate ? ` at ${Math.round(actual.frameRate)} FPS` : ''}`
          : 'not reported by this camera';
      setCameraStatus(
        `Requested ${requestedCameraLabel(settings)}. Actual ${actualLabel}. Camera preview is local and is not being recorded.`,
      );
      await refresh();
    } catch (error) {
      if (request === cameraRequest.current) {
        stopCamera();
        if (alive.current) setCameraStatus(message(error, 'camera'));
      }
    }
  }

  async function togglePreview() {
    if (previewing) {
      stopCamera();
      setCameraStatus('Preview stopped.');
      return;
    }
    await startCameraPreview();
  }

  function updateCameraQuality(next: CameraSettings) {
    setCameraQuality(next);
    writeCameraSettings(next);
    window.dispatchEvent(new Event('bc-camera-quality'));
    if (previewing) void startCameraPreview(next);
  }

  async function testOutput() {
    setOutputStatus('');
    let context: AudioContext | null = null;
    let master: ReturnType<typeof createOutputGain> | null = null;
    try {
      closeContext(outputContext.current);
      context = new AudioContext();
      outputContext.current = context;
      await applyOutputDevice(context);
      if (!alive.current || outputContext.current !== context) {
        closeContext(context);
        return;
      }
      await context.resume();
      if (!alive.current || outputContext.current !== context) {
        closeContext(context);
        return;
      }
      const oscillator = context.createOscillator(),
        gain = context.createGain();
      master = createOutputGain(context);
      oscillator.frequency.value = 440;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + 0.55,
      );
      oscillator.connect(gain).connect(master.gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.6);
      oscillator.onended = () => {
        master?.dispose();
        if (outputContext.current === context) outputContext.current = null;
        closeContext(context);
      };
      setOutputStatus('Test tone played through the selected output.');
    } catch (error) {
      master?.dispose();
      closeContext(context);
      if (outputContext.current === context) outputContext.current = null;
      if (alive.current) setOutputStatus(message(error));
    }
  }

  const denied = (status: string) => /denied|privacy settings/i.test(status);
  const openPrivacy = async (kind: PermissionKind) => {
    try {
      await invoke('open_media_privacy_settings', { kind });
    } catch (error) {
      (kind === 'camera' ? setCameraStatus : setMicStatus)(message(error));
    }
  };
  return (
    <section className="device-settings" aria-label="Media devices">
      <div className="device-settings__grid">
        <div className="device-settings__card">
          <label>
            Microphone
            <select
              value={input}
              onChange={(e) => {
                stopMic();
                stopPlayback();
                setInput(e.target.value);
                localStorage.setItem('bc-input', e.target.value);
                window.dispatchEvent(new Event('bc-devices'));
              }}
            >
              <option value="">System default</option>
              {devices
                .filter((d) => d.kind === 'audioinput' && d.deviceId)
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Microphone ${i + 1}`}
                  </option>
                ))}
            </select>
          </label>
          <label className="device-volume">
            <span>Input volume <output>{Math.round(inputVolume * 100)}%</output></span>
            <input
              aria-label="Input volume"
              aria-valuetext={`${Math.round(inputVolume * 100)} percent`}
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={inputVolume}
              onChange={(event) => {
                const value = Number(event.target.value);
                setInputVolumeState(value);
                setInputVolume(value);
              }}
            />
          </label>
          <div className="device-settings__actions">
            <button
              className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
              type="button"
              onClick={() => void enable('microphone')}
            >
              Enable microphone
            </button>
            <button
              className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
              type="button"
              disabled={recording}
              onClick={() => void testMicrophone()}
            >
              {recording ? 'Recording…' : 'Test microphone'}
            </button>
            <button
              className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
              type="button"
              aria-pressed={monitoring}
              onClick={() => {
                if (monitoring) {
                  stopMic();
                  setMicStatus('Live loopback stopped.');
                } else void testMicrophone('live');
              }}
            >
              {monitoring ? 'Stop live loopback' : 'Start live loopback'}
            </button>
            {windowsDesktop && denied(micStatus) && (
              <button
                className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
                type="button"
                onClick={() => void openPrivacy('microphone')}
              >
                Open privacy settings
              </button>
            )}
          </div>
          {monitoring && (
            <label className="loopback-volume">
              Monitor volume · {Math.round(monitorVolume * 100)}%
              <input
                type="range"
                aria-label="Monitor volume"
                min="0"
                max="1"
                step="0.05"
                value={monitorVolume}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  monitorVolumeRef.current = value;
                  setMonitorVolume(value);
                  monitorGain.current?.gain.setTargetAtTime(
                    value,
                    monitorGain.current.context.currentTime,
                    0.02,
                  );
                }}
              />
              <span>
                Continuous audio, one second behind. Use headphones: echo
                cancellation is off during live monitoring. Your selected noise
                processing still applies. Nothing is saved.
              </span>
            </label>
          )}
          <div
            className="device-settings__meter"
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level)}
          >
            <span style={{ '--level': `${level}%` } as React.CSSProperties} />
          </div>
          {micLevels && (
            <div className="device-settings__status">
              <p>
                Last measured: input {micLevels.input.toFixed(1)} dBFS ·
                processed {micLevels.processed.toFixed(1)} dBFS
              </p>
              <p>
                Loudest level: input {micLevels.inputPeak.toFixed(1)} dBFS ·
                processed {micLevels.processedPeak.toFixed(1)} dBFS
              </p>
              <button
                type="button"
                className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(JSON.stringify(micDiagnostic.current, null, 2))
                    .then(
                      () =>
                        setDiagnosticStatus(
                          'Microphone diagnostics copied. No audio or device identifiers included.',
                        ),
                      () =>
                        setDiagnosticStatus(
                          'Could not copy diagnostics. Allow clipboard access and try again.',
                        ),
                    );
                }}
              >
                Copy microphone diagnostics
              </button>
              {diagnosticStatus && <p role="status">{diagnosticStatus}</p>}
            </div>
          )}
          {micStatus && (
            <p
              className="device-settings__status"
              data-error={denied(micStatus)}
              role="status"
            >
              {micStatus}
            </p>
          )}
        </div>
        <div className="device-settings__card">
          <label>
            Output device
            <select
              value={output}
              onChange={(e) => {
                stopPlayback();
                closeContext(outputContext.current);
                outputContext.current = null;
                setOutput(e.target.value);
                localStorage.setItem('bc-output', e.target.value);
                window.dispatchEvent(new Event('bc-output'));
              }}
            >
              <option value="">System default</option>
              {devices
                .filter((d) => d.kind === 'audiooutput' && d.deviceId)
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Speaker ${i + 1}`}
                  </option>
                ))}
            </select>
          </label>
          <label className="device-volume">
            <span>Output volume <output>{Math.round(outputVolume * 100)}%</output></span>
            <input
              aria-label="Output volume"
              aria-valuetext={`${Math.round(outputVolume * 100)} percent`}
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={outputVolume}
              onChange={(event) => {
                const value = Number(event.target.value);
                setOutputVolumeState(value);
                setOutputVolume(value);
              }}
            />
          </label>
          <div className="device-settings__actions">
            <button
              className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
              type="button"
              onClick={() => void testOutput()}
            >
              Play test tone
            </button>
          </div>
          {outputStatus && (
            <p
              className="device-settings__status"
              data-error={/cannot|failed|error/i.test(outputStatus)}
              role="status"
            >
              {outputStatus}
            </p>
          )}
        </div>
        <div className="device-settings__card">
          <label>
            Camera
            <select
              value={camera}
              onChange={(e) => {
                stopCamera();
                setCameraCapabilities(null);
                setCameraActual(null);
                setCamera(e.target.value);
                localStorage.setItem('bc-camera', e.target.value);
                window.dispatchEvent(new Event('bc-devices'));
              }}
            >
              <option value="">System default</option>
              {devices
                .filter((d) => d.kind === 'videoinput' && d.deviceId)
                .map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
            </select>
          </label>
          <div className="camera-quality" aria-label="Camera quality">
            <label>
              Resolution
              <select
                value={cameraQuality.resolution}
                onChange={(event) =>
                  updateCameraQuality({
                    ...cameraQuality,
                    resolution: event.target
                      .value as CameraSettings['resolution'],
                  })
                }
              >
                {cameraResolutions.map((option) => {
                  const unsupported = !cameraResolutionSupported(
                    option.value,
                    cameraCapabilities,
                  );
                  return (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={unsupported}
                    >
                      {option.label}
                      {unsupported ? ' · unavailable' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              Frame rate
              <select
                value={cameraQuality.frameRate}
                onChange={(event) =>
                  updateCameraQuality({
                    ...cameraQuality,
                    frameRate: Number(
                      event.target.value,
                    ) as CameraSettings['frameRate'],
                  })
                }
              >
                {cameraFrameRates.map((rate) => {
                  const unsupported = !cameraFrameRateSupported(
                    rate,
                    cameraCapabilities,
                  );
                  return (
                    <option key={rate} value={rate} disabled={unsupported}>
                      {rate} FPS{unsupported ? ' · unavailable' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
          </div>
          {previewing && cameraActual && (
            <p className="camera-quality__actual">
              Camera reports {cameraActual.width ?? 'unknown'}×
              {cameraActual.height ?? 'unknown'} at{' '}
              {cameraActual.frameRate
                ? `${Math.round(cameraActual.frameRate)} FPS`
                : 'an unknown frame rate'}
              .
            </p>
          )}
          <div className="device-settings__actions">
            <button
              className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
              type="button"
              onClick={() => void enable('camera')}
            >
              Enable camera
            </button>
            <button
              className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
              type="button"
              onClick={() => void togglePreview()}
            >
              {previewing ? 'Stop preview' : 'Preview camera'}
            </button>
            {windowsDesktop && denied(cameraStatus) && (
              <button
                className="my-3 p-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
                type="button"
                onClick={() => void openPrivacy('camera')}
              >
                Open privacy settings
              </button>
            )}
          </div>
          <video
            ref={videoRef}
            className="device-settings__preview"
            muted
            playsInline
            hidden={!previewing}
          />
          {cameraStatus && (
            <p
              className="device-settings__status"
              data-error={denied(cameraStatus)}
              role="status"
            >
              {cameraStatus}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
