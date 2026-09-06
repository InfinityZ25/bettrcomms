import { useEffect, useState } from 'react';
import { Headphones, Monitor, Radio } from 'lucide-react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import DeviceSettings from './DeviceSettings';
import ProcessingControls from './ProcessingControls';
import { readSpeakingThreshold, saveSpeakingThreshold } from './media/speakingSensitivity';
import { readRecordingQuality } from './media/recordingQuality';
import NativeDeepfilterSetup, {
  type DeepfilterStatus,
} from './NativeDeepfilterSetup';

interface NvidiaStatus {
  ready: boolean;
  detail: string;
  sampleRate: number;
  frameSamples: number | null;
}
interface NvidiaInstallInfo {
  schemaVersion: number;
  supported: boolean;
  installed: boolean;
  gpuName: string | null;
  selectedPackage: string | null;
  downloadBytes: number;
  detail: string;
}
export const defaultQuality = {
  maxVideoBitrate: 20_000_000,
  maxAudioBitrate: 256_000,
  maxFramerate: 60,
  scaleResolutionDownBy: 1,
};
export function readQuality() {
  try {
    return {
      ...defaultQuality,
      ...JSON.parse(localStorage.getItem('bc-quality') ?? '{}'),
    };
  } catch {
    return defaultQuality;
  }
}
export default function MediaSettings() {
  const [speakingThreshold, setSpeakingThreshold] = useState(readSpeakingThreshold);
  const [voiceRoute, setVoiceRoute] = useState(() => localStorage.getItem('bc-voice-route') === 'relay' ? 'relay' : 'automatic');
  const [recordingRate, setRecordingRate] = useState(() => readRecordingQuality().screenVideoBitsPerSecond / 1_000_000);
  const desktop = isTauri();
  const storedDenoiser = localStorage.getItem('bc-denoiser');
  const initialDenoiser =
    (storedDenoiser === 'nvidia' || storedDenoiser === 'deepfilter') && !desktop
      ? 'standard'
      : (storedDenoiser ?? 'standard');
  const [quality, setQuality] = useState(readQuality),
    [direct, setDirect] = useState(
      localStorage.getItem('bc-direct') === 'true',
    ),
    [denoiser, setDenoiser] = useState(initialDenoiser),
    [nvidia, setNvidia] = useState<NvidiaStatus | null>(null),
    [nvidiaInfo, setNvidiaInfo] = useState<NvidiaInstallInfo | null>(null),
    [nvidiaBusy, setNvidiaBusy] = useState(false),
    [nvidiaInstallError, setNvidiaInstallError] = useState('');
  const [deepfilter, setDeepfilter] = useState<DeepfilterStatus | null>(null);
  async function refreshNvidia() {
    if (!desktop) return;
    try {
      const [status, info] = await Promise.all([
        invoke<NvidiaStatus>('nvidia_status'),
        invoke<NvidiaInstallInfo>('nvidia_install_info'),
      ]);
      setNvidia(status);
      setNvidiaInfo(info);
      if (!status.ready && localStorage.getItem('bc-denoiser') === 'nvidia') {
        setDenoiser('rnnoise');
        localStorage.setItem('bc-denoiser', 'rnnoise');
        window.dispatchEvent(new Event('bc-denoiser'));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNvidia({
        ready: false,
        detail,
        sampleRate: 48_000,
        frameSamples: null,
      });
      setNvidiaInfo(null);
    }
  }
  useEffect(() => {
    void refreshNvidia();
  }, [desktop]);
  async function installNvidia() {
    if (!nvidiaInfo?.supported || !nvidiaInfo.selectedPackage) return;
    setNvidiaBusy(true);
    setNvidiaInstallError('');
    try {
      await invoke('nvidia_install');
    } catch (error) {
      setNvidiaInstallError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setNvidiaBusy(false);
      await refreshNvidia();
    }
  }
  function change(next: typeof quality) {
    setQuality(next);
    localStorage.setItem('bc-quality', JSON.stringify(next));
    window.dispatchEvent(new Event('bc-quality'));
  }
  return (
    <>
      <h3><Headphones size={17} /> Voice & devices</h3>
      <DeviceSettings />
      <label>
        Speaking indicator threshold · {speakingThreshold} dBFS
        <input type="range" min="-65" max="-20" step="1"
          aria-label="Speaking indicator threshold"
          aria-describedby="speaking-threshold-help"
          value={speakingThreshold}
          onChange={event => setSpeakingThreshold(saveSpeakingThreshold(Number(event.target.value)))} />
      </label>
      <p id="speaking-threshold-help" className="friend-status">
        Lower values detect quieter voices. This changes the green border only, not microphone volume or what others hear.
      </p>
      <label>
        Noise suppression engine
        <select
          value={denoiser}
          onChange={(e) => {
            setDenoiser(e.target.value);
            localStorage.setItem('bc-denoiser', e.target.value);
            window.dispatchEvent(new Event('bc-denoiser'));
          }}
        >
          <option value="standard">Standard · browser processing</option>
          <option value="rnnoise">Enhanced · RNNoise on this device</option>
          <option value="speex">SpeexDSP · lightweight on this device</option>
          {desktop && (
            <option value="nvidia" disabled={!nvidia?.ready}>
              NVIDIA Audio Effects ·{' '}
              {nvidia?.ready ? 'ready' : 'setup required'}
            </option>
          )}
          {desktop && (
            <option value="deepfilter" disabled={!deepfilter?.ready}>
              DeepFilterNet · AMD/Intel GPU ·{' '}
              {deepfilter?.ready ? 'ready' : 'setup required'}
            </option>
          )}
        </select>
      </label>
      <p className="friend-status">
        Used when noise suppression is switched on. Processing stays on this
        device.
      </p>
      {desktop && nvidia && !nvidia.ready && (
        <div className="setting-note">
          <p>NVIDIA Audio Effects is unavailable: {nvidia.detail}</p>
          {nvidiaInfo && (
            <>
              <p>
                {nvidiaInfo.gpuName
                  ? `Detected GPU: ${nvidiaInfo.gpuName}. `
                  : ''}
                {nvidiaInfo.detail}
              </p>
              {nvidiaInfo.supported && nvidiaInfo.selectedPackage && (
                <>
                  <p>
                    Setup downloads an optional{' '}
                    {Math.round(nvidiaInfo.downloadBytes / 1024 / 1024)} MiB
                    component and processes microphone audio on your local GPU.
                  </p>
                  <p>
                    By installing it, you agree to the{' '}
                    <a
                      href="https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-software-license-agreement/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      NVIDIA Software License Agreement
                    </a>{' '}
                    and{' '}
                    <a
                      href="https://www.nvidia.com/en-us/agreements/enterprise-software/product-specific-terms-for-ai-products/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      AI product-specific terms
                    </a>
                    .
                  </p>
                  <button
                    className="text-button"
                    disabled={nvidiaBusy}
                    onClick={installNvidia}
                  >
                    {nvidiaBusy
                      ? 'Installing NVIDIA Audio Effects…'
                      : nvidiaInstallError
                        ? 'Retry NVIDIA setup'
                        : 'Download and set up NVIDIA Audio Effects'}
                  </button>
                </>
              )}
              {!nvidiaInfo.supported && (
                <p>NVIDIA setup is unavailable for this GPU.</p>
              )}
              {nvidiaInstallError && (
                <p>NVIDIA setup failed: {nvidiaInstallError}</p>
              )}
            </>
          )}
        </div>
      )}
      {desktop && nvidia?.ready && (
        <p className="friend-status">
          NVIDIA Audio Effects is ready. {nvidia.detail}
        </p>
      )}
      {desktop && (
        <NativeDeepfilterSetup
          onStatus={(status) => {
            setDeepfilter(status);
            if (
              !status.ready &&
              localStorage.getItem('bc-denoiser') === 'deepfilter'
            ) {
              setDenoiser('rnnoise');
              localStorage.setItem('bc-denoiser', 'rnnoise');
              window.dispatchEvent(new Event('bc-denoiser'));
            }
          }}
        />
      )}
      <ProcessingControls engine={denoiser} />
      <h3><Monitor size={17} /> Recording quality</h3>
      <label>Screen recording bitrate<select value={recordingRate} onChange={(event) => {
        const value = Number(event.target.value); setRecordingRate(value);
        localStorage.setItem('bc-recording-mbps', String(value));
      }}>{[10, 20, 40, 80].map((value) => <option key={value} value={value}>{value} Mbps</option>)}</select></label>
      <p className="setting-note">Applies to new browser and received-screen recordings. Native local shares preserve the selected stream encoder and bitrate. Higher bitrates use more storage; playback volume never changes the saved tracks.</p>
      <h3>
        <Monitor size={17} /> Stream quality
      </h3>
      <div className="settings-grid">
        <label>
          Video bitrate ceiling
          <select
            value={quality.maxVideoBitrate}
            onChange={(e) =>
              change({ ...quality, maxVideoBitrate: Number(e.target.value) })
            }
          >
            <option value={4_000_000}>4 Mbps · save bandwidth</option>
            <option value={10_000_000}>10 Mbps · balanced</option>
            <option value={20_000_000}>20 Mbps · high quality</option>
            <option value={40_000_000}>40 Mbps · maximum detail</option>
          </select>
        </label>
        <label>
          Frame rate ceiling
          <select
            value={quality.maxFramerate}
            onChange={(e) =>
              change({ ...quality, maxFramerate: Number(e.target.value) })
            }
          >
            <option value={15}>15 FPS · text</option>
            <option value={30}>30 FPS · balanced</option>
            <option value={60}>60 FPS · motion</option>
          </select>
        </label>
        <label>
          Audio bitrate ceiling
          <select
            value={quality.maxAudioBitrate}
            onChange={(e) =>
              change({ ...quality, maxAudioBitrate: Number(e.target.value) })
            }
          >
            <option value={64_000}>64 kbps · voice</option>
            <option value={128_000}>128 kbps · balanced</option>
            <option value={256_000}>256 kbps · high fidelity</option>
            <option value={510_000}>510 kbps · maximum</option>
          </select>
        </label>
      </div>
      <p className="setting-note">
        Actual quality adapts to your connection and device. Each viewer uses
        additional upload bandwidth. Hardware encoding is selected by your
        browser when supported.
      </p>
      <h3>
        <Radio size={17} /> Connection
      </h3>
      <label className="switch-row">
        <div>
          <strong>Direct connections only</strong>
          <p>Skip media relays. Some networks may not connect.</p>
        </div>
        <input
          type="checkbox"
          checked={direct}
          onChange={(e) => {
            setDirect(e.target.checked);
            localStorage.setItem('bc-direct', String(e.target.checked));
          }}
        />
      </label>
      <p className="friend-status">
        Connection mode applies when you next join a call.
      </p>
      <label className="device-select">
        Voice route
        <select disabled={direct} value={voiceRoute} onChange={event => {
          setVoiceRoute(event.target.value);
          localStorage.setItem('bc-voice-route', event.target.value);
        }}>
          <option value="automatic">Automatic · direct first, server voice fallback</option>
          <option value="relay">Server voice · compatibility mode</option>
        </select>
      </label>
      <p className="setting-note">
        Server voice uses encrypted Opus audio, starting at 64 kbps per friend.
        Camera, screen sharing, and shared app audio still need WebRTC connectivity.
        Direct-only overrides this setting. Changes apply on your next call.
      </p>
    </>
  );
}
