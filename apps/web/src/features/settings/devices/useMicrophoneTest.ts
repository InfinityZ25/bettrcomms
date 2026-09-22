import { useCallback, useEffect, useRef, useState } from 'react';
import { MediaEngine } from '@/media/engine';
import { applyOutputDevice, followElementOutput, followOutputDevice } from '@/media/output';
import { createOutputGain } from '@/media/volumeSettings';
import { microphoneCaptureOptions, readProcessingSettings } from '@/media/processingSettings';
import { closeContext, deviceError, ensureDesktopPermission } from './deviceHelpers';

export type MicrophoneLevels = {
  input: number;
  processed: number;
  inputPeak: number;
  processedPeak: number;
};

export type TestMode = 'sample' | 'live';

const ENGINE_LABELS: Record<string, string> = {
  standard: 'Browser',
  rnnoise: 'RNNoise',
  speex: 'Speex',
  'deepfilter-wasm': 'DeepFilterNet3',
  nvidia: 'NVIDIA',
  deepfilter: 'DeepFilterNet',
  off: 'Suppression off',
};

const SILENCE_DB = -120;

/** RMS of a time-domain window, in dBFS. */
const decibels = (samples: Float32Array) =>
  Math.max(
    SILENCE_DB,
    20 *
      Math.log10(
        Math.sqrt(
          samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
        ) || 1e-6,
      ),
  );

const trackFormat = ({
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

/**
 * The two microphone tests: a five-second sample played back, and a continuous
 * one-second-delayed loopback. Both run the real processing chain through a
 * throwaway MediaEngine so what you hear is what the call would send.
 *
 * Every async step re-checks `request`, because a person can restart or stop a
 * test at any point and a stale continuation must not touch live audio nodes.
 */
export function useMicrophoneTest({
  alive,
  input,
  windowsDesktop,
  refresh,
  onStatus,
}: {
  alive: React.RefObject<boolean>;
  input: string;
  windowsDesktop: boolean;
  refresh: () => Promise<void>;
  onStatus: (status: string) => void;
}) {
  const [level, setLevel] = useState(0);
  const [levels, setLevels] = useState<MicrophoneLevels | null>(null);
  const [recording, setRecording] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const [monitorVolume, setMonitorVolume] = useState(0.5);
  const [diagnosticStatus, setDiagnosticStatus] = useState('');

  const diagnostic = useRef<Record<string, unknown> | null>(null);
  const monitorVolumeRef = useRef(0.5);
  const monitorGain = useRef<GainNode | null>(null);
  const monitorCleanup = useRef<(() => void) | null>(null);
  const meterCleanup = useRef<(() => void) | null>(null);
  const engine = useRef<MediaEngine | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const animation = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const request = useRef(0);

  const playback = useRef<HTMLAudioElement | null>(null);
  const playbackCleanup = useRef<(() => void) | null>(null);
  const playbackRequest = useRef(0);
  const blobUrl = useRef<string | null>(null);

  const stop = useCallback(() => {
    request.current += 1;
    meterCleanup.current?.();
    meterCleanup.current = null;
    monitorCleanup.current?.();
    monitorCleanup.current = null;
    monitorGain.current = null;
    setMonitoring(false);
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    timer.current = animation.current = null;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    engine.current?.dispose();
    engine.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    closeContext(context.current);
    context.current = null;
    setLevel(0);
    setRecording(false);
  }, []);

  const stopPlayback = useCallback(() => {
    playbackRequest.current += 1;
    playbackCleanup.current?.();
    playbackCleanup.current = null;
    if (playback.current) {
      playback.current.pause();
      playback.current.removeAttribute('src');
      playback.current.load();
    }
    playback.current = null;
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = null;
  }, []);

  useEffect(() => () => {
    stop();
    stopPlayback();
  }, [stop, stopPlayback]);

  // A processing change invalidates whatever the last test demonstrated.
  useEffect(() => {
    const changed = () => {
      const hadTest = Boolean(engine.current || playback.current);
      stop();
      stopPlayback();
      if (hadTest)
        onStatus('Processing settings changed. Run a new microphone test to hear them.');
    };
    const events = ['bc-processing', 'bc-denoiser', 'bc-noise'];
    for (const event of events) window.addEventListener(event, changed);
    return () => {
      for (const event of events) window.removeEventListener(event, changed);
    };
  }, [stop, stopPlayback, onStatus]);

  const setMonitorLevel = (value: number) => {
    monitorVolumeRef.current = value;
    setMonitorVolume(value);
    monitorGain.current?.gain.setTargetAtTime(
      value,
      monitorGain.current.context.currentTime,
      0.02,
    );
  };

  const copyDiagnostics = () =>
    void navigator.clipboard
      .writeText(JSON.stringify(diagnostic.current, null, 2))
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

  async function start(mode: TestMode = 'sample') {
    stop();
    stopPlayback();
    setLevels(null);
    diagnostic.current = null;
    setDiagnosticStatus('');
    onStatus(mode === 'live' ? 'Starting live loopback…' : '');
    setMonitoring(mode === 'live');
    const current = ++request.current;
    const stale = () => !alive.current || current !== request.current;
    try {
      await ensureDesktopPermission('microphone');
      if (stale()) return;

      const settings = readProcessingSettings();
      let activeEngine = settings.engine;
      let engineNotice = '';
      const engineLabel = () => ENGINE_LABELS[activeEngine];
      const liveStatus = () =>
        `Live loopback · ${engineLabel()} · 1-second delay.${engineNotice ? ' ' + engineNotice : ''}`;

      const capture = new MediaEngine({
        signaling: { localPeerId: 'microphone-test', send() {} },
      });
      engine.current = capture;
      capture.addEventListener('denoiser-status', (event) => {
        if (stale()) return;
        activeEngine = event.detail.active;
        engineNotice = event.detail.message;
        if (mode === 'live' && monitorCleanup.current) onStatus(liveStatus());
        else if (recorder.current) {
          stop();
          stopPlayback();
          onStatus(event.detail.message + ' Run the microphone test again.');
        }
      });
      capture.addEventListener('error', (event) => {
        if (stale()) return;
        stop();
        stopPlayback();
        onStatus(deviceError(event.detail.error));
      });

      const options = microphoneCaptureOptions(input);
      // Monitoring intentionally plays the user's own voice. Echo cancellation
      // can learn that playback as echo and suppress sustained speech. Keep
      // call/sample preferences intact; only headphone monitoring opts out.
      if (mode === 'live') options.echoCancellation = false;
      await capture.captureUserMedia(options);
      const captured = capture.getLocalTracks().get('microphone');
      if (!captured) throw new Error('The microphone test did not produce audio.');
      const engineName = engineLabel();
      if (stale()) {
        captured.stop();
        return;
      }
      stream.current = new MediaStream([captured]);

      const audio = new AudioContext();
      context.current = audio;
      if (mode === 'live') await applyOutputDevice(audio);
      if (stale()) {
        closeContext(audio);
        return;
      }
      await audio.resume();
      if (stale()) {
        stream.current?.getTracks().forEach((track) => track.stop());
        closeContext(audio);
        return;
      }

      // Processing may have fallen back while output routing was awaiting.
      const processedTrack = capture.getLocalTracks().get('microphone');
      if (!processedTrack || processedTrack.readyState === 'ended')
        throw new Error('The microphone stopped during test startup.');
      const processedStream = new MediaStream([processedTrack]);
      stream.current = processedStream;

      const analyser = audio.createAnalyser();
      analyser.fftSize = 256;
      let source = audio.createMediaStreamSource(processedStream);
      source.connect(analyser);

      const rawTrack = capture.getMicrophoneInput();
      const rawAnalyser = audio.createAnalyser();
      rawAnalyser.fftSize = 1024;
      const rawSource = rawTrack
        ? audio.createMediaStreamSource(new MediaStream([rawTrack]))
        : null;
      rawSource?.connect(rawAnalyser);
      const rawSettings = rawTrack?.getSettings() ?? {};

      const channelCount = Math.min(8, Math.max(1, rawSettings.channelCount ?? 1));
      const splitter = audio.createChannelSplitter(channelCount);
      const channelMeters = Array.from({ length: channelCount }, (_, channel) => {
        const meter = audio.createAnalyser();
        meter.fftSize = 1024;
        splitter.connect(meter, channel);
        return { meter, samples: new Float32Array(meter.fftSize), peak: SILENCE_DB };
      });
      rawSource?.connect(splitter);
      meterCleanup.current = () => {
        rawSource?.disconnect();
        rawAnalyser.disconnect();
        splitter.disconnect();
        channelMeters.forEach(({ meter }) => meter.disconnect());
      };

      const processedValues = new Float32Array(analyser.fftSize);
      const rawValues = new Float32Array(rawAnalyser.fftSize);
      let lastMeterUpdate = 0;
      let inputPeak = SILENCE_DB;
      let processedPeak = SILENCE_DB;
      const draw = () => {
        analyser.getFloatTimeDomainData(processedValues);
        rawAnalyser.getFloatTimeDomainData(rawValues);
        const processed = decibels(processedValues);
        const raw = decibels(rawValues);
        inputPeak = Math.max(inputPeak, raw);
        processedPeak = Math.max(processedPeak, processed);
        const now = performance.now();
        if (now - lastMeterUpdate >= 100) {
          lastMeterUpdate = now;
          const inputChannels = channelMeters.map((entry) => {
            entry.meter.getFloatTimeDomainData(entry.samples);
            const value = decibels(entry.samples);
            entry.peak = Math.max(entry.peak, value);
            return { current: value, peak: entry.peak };
          });
          setLevel(Math.max(0, Math.min(100, ((processed + 72) / 72) * 100)));
          const measured = { input: raw, processed, inputPeak, processedPeak };
          setLevels(measured);
          diagnostic.current = {
            version: 1,
            runtime: windowsDesktop ? 'windows-webview' : 'browser',
            test: mode,
            inputAvailable: Boolean(rawTrack),
            browserVersion: navigator.userAgent.match(/(?:Chrome|Edg)\/[\d.]+/g),
            requestedProcessing: {
              ...settings,
              echoCancellation: options.echoCancellation ?? settings.echoCancellation,
            },
            activeEngine: engineLabel(),
            inputFormat: trackFormat(rawSettings),
            // Read the current processed track so a denoiser fallback is reflected.
            processedFormat: trackFormat(
              capture.getLocalTracks().get('microphone')?.getSettings() ?? {},
            ),
            levelsDbfs: measured,
            inputChannelsDbfs: inputChannels,
          };
        }
        animation.current = requestAnimationFrame(draw);
      };
      draw();

      if (mode === 'live') {
        const delay = audio.createDelay(1.1);
        delay.delayTime.value = 1;
        const gain = audio.createGain();
        const master = createOutputGain(audio);
        gain.gain.value = monitorVolumeRef.current;
        monitorGain.current = gain;
        analyser.connect(delay).connect(gain).connect(master.gain).connect(audio.destination);
        const failed = (error: Error) => {
          if (stale()) return;
          stop();
          onStatus(error.message);
        };
        const stopOutput = followOutputDevice(audio, failed);
        const replaced = (
          event: CustomEvent<{ source: string; track: MediaStreamTrack | null }>,
        ) => {
          if (event.detail.source !== 'microphone' || stale()) return;
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
            const nextSource = audio.createMediaStreamSource(nextStream);
            source.disconnect();
            source = nextSource;
            source.connect(analyser);
            stream.current = nextStream;
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
        onStatus(liveStatus());
        await refresh();
        return;
      }

      const chunks: Blob[] = [];
      const activeRecorder = new MediaRecorder(processedStream);
      recorder.current = activeRecorder;
      activeRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      activeRecorder.onstop = async () => {
        if (current !== request.current || !alive.current) return;
        stop();
        const url = URL.createObjectURL(new Blob(chunks, { type: activeRecorder.mimeType }));
        blobUrl.current = url;
        const element = new Audio(url);
        playback.current = element;
        const playbackId = ++playbackRequest.current;
        try {
          playbackCleanup.current = followElementOutput(element, (error: Error) => {
            if (alive.current && playback.current === element) onStatus(deviceError(error));
          });
          if (
            !alive.current ||
            playbackId !== playbackRequest.current ||
            playback.current !== element
          )
            return;
          await element.play();
          if (alive.current && playback.current === element)
            onStatus(
              `Playing your 5-second ${engineName} microphone sample.${engineNotice ? ' ' + engineNotice : ''}`,
            );
        } catch (error) {
          if (alive.current && playback.current === element)
            onStatus(deviceError(error));
        }
        element.onended = stopPlayback;
      };
      activeRecorder.start();
      setRecording(true);
      onStatus(
        `Recording a 5-second ${engineName} sample…${engineNotice ? ' ' + engineNotice : ''}`,
      );
      timer.current = window.setTimeout(() => {
        if (activeRecorder.state === 'recording') activeRecorder.stop();
      }, 5000);
      await refresh();
    } catch (error) {
      if (current === request.current) {
        stop();
        if (alive.current) onStatus(deviceError(error, 'microphone'));
      }
    }
  }

  return {
    level,
    levels,
    recording,
    monitoring,
    monitorVolume,
    setMonitorLevel,
    diagnosticStatus,
    copyDiagnostics,
    start,
    stop,
    stopPlayback,
  };
}
