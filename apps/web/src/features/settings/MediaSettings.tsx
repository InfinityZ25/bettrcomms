import { errorMessage } from '@/lib/errors';
import { LinkButton } from '@/components/ui/link-button';
import { Switch } from '@/components/ui/switch';
import { useEffect, useState } from 'react';
import { readStored, writeStored } from '@/lib/storage';
import { Headphones, Monitor, Radio } from 'lucide-react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import DeviceSettings from './DeviceSettings';
import VisualCopilotSettings from './VisualCopilotSettings';
import ProcessingControls from './ProcessingControls';
import {
  readSpeakingThreshold,
  saveSpeakingThreshold,
} from '@/media/speakingSensitivity';
import { readRecordingQuality } from '@/media/recordingQuality';
import NativeDeepfilterSetup, {
  type DeepfilterStatus,
} from './NativeDeepfilterSetup';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { SettingsSelect, SettingsSlider } from './SettingsControls';

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
      ...JSON.parse(readStored('bc-quality') ?? '{}'),
    };
  } catch {
    return defaultQuality;
  }
}
export default function MediaSettings({ section }: { section: 'voice' | 'recording' | 'stream' | 'connection' }) {
  const [speakingThreshold, setSpeakingThreshold] = useState(
    readSpeakingThreshold,
  );
  const [voiceRoute, setVoiceRoute] = useState(() =>
    readStored('bc-voice-route') === 'relay' ? 'relay' : 'automatic',
  );
  const [recordingRate, setRecordingRate] = useState(
    () => readRecordingQuality().screenVideoBitsPerSecond / 1_000_000,
  );
  const desktop = isTauri();
  const storedDenoiser = readStored('bc-denoiser');
  const initialDenoiser =
    (storedDenoiser === 'nvidia' || storedDenoiser === 'deepfilter') && !desktop
      ? 'standard'
      : (storedDenoiser ?? 'rnnoise');
  const [quality, setQuality] = useState(readQuality),
    [direct, setDirect] = useState(
      readStored('bc-direct') === 'true',
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
      if (!status.ready && readStored('bc-denoiser') === 'nvidia') {
        setDenoiser('rnnoise');
        writeStored('bc-denoiser', 'rnnoise');
        window.dispatchEvent(new Event('bc-denoiser'));
      }
    } catch (error) {
      const detail = errorMessage(error);
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
        errorMessage(error),
      );
    } finally {
      setNvidiaBusy(false);
      await refreshNvidia();
    }
  }
  function change(next: typeof quality) {
    setQuality(next);
    writeStored('bc-quality', JSON.stringify(next));
    window.dispatchEvent(new Event('bc-quality'));
  }
  return (
    <>
      {section === 'voice' && <SettingsSection
        id="settings-voice"
        icon={<Headphones size={18} />}
        title="Voice & devices"
        description="Pick what you use for calls and make sure everything sounds right."
      >
      <DeviceSettings />
      <VisualCopilotSettings />
      <label className="grid gap-3">
        <span className="flex justify-between gap-3">Voice activity <output>{speakingThreshold} dB</output></span>
        <SettingsSlider ariaLabel="Speaking indicator threshold" value={speakingThreshold} min={-65} max={-20} step={1} onValueChange={(value) => setSpeakingThreshold(saveSpeakingThreshold(value))} />
      </label>
      <p
        id="speaking-threshold-help"
        className="text-xs leading-6 text-muted-foreground"
      >
        Adjust when your speaking indicator lights up. This does not change your volume.
      </p>
      <label className="grid gap-2">
        Noise removal
        <SettingsSelect
          ariaLabel="Noise suppression engine"
          value={denoiser}
          onValueChange={(value) => {
            setDenoiser(value);
            writeStored('bc-denoiser', value);
            window.dispatchEvent(new Event('bc-denoiser'));
          }}
          options={[
            { value: 'rnnoise', label: 'Enhanced' },
            { value: 'standard', label: 'Standard' },
            { value: 'speex', label: 'Lightweight' },
            { value: 'deepfilter-wasm', label: 'DeepFilter · experimental' },
            ...(desktop ? [{ value: 'nvidia', label: nvidia?.ready ? 'NVIDIA · ready' : 'NVIDIA · setup needed', disabled: !nvidia?.ready }] : []),
            ...(desktop ? [{ value: 'deepfilter', label: deepfilter?.ready ? 'DeepFilter · ready' : 'DeepFilter · setup needed', disabled: !deepfilter?.ready }] : []),
          ]}
        />
      </label>
      <p className="text-xs leading-6 text-muted-foreground">Choose how strongly BetterComms cleans up your microphone.</p>
      {denoiser === 'deepfilter-wasm' && (
        <p className="setting-note">
          DeepFilter is still being tested. Enhanced is the safer choice for calls.
        </p>
      )}
      {desktop && nvidia && !nvidia.ready && (
        <div className="my-4 rounded-lg border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
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
                  <LinkButton
                    disabled={nvidiaBusy}
                    onClick={installNvidia}
                  >
                    {nvidiaBusy
                      ? 'Installing NVIDIA Audio Effects…'
                      : nvidiaInstallError
                        ? 'Retry NVIDIA setup'
                        : 'Download and set up NVIDIA Audio Effects'}
                  </LinkButton>
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
        <p className="text-xs leading-6 text-muted-foreground">
          NVIDIA Audio Effects is ready. {nvidia.detail}
        </p>
      )}
      {desktop && (
        <NativeDeepfilterSetup
          onStatus={(status) => {
            setDeepfilter(status);
            if (
              !status.ready &&
              readStored('bc-denoiser') === 'deepfilter'
            ) {
              setDenoiser('rnnoise');
              writeStored('bc-denoiser', 'rnnoise');
              window.dispatchEvent(new Event('bc-denoiser'));
            }
          }}
        />
      )}
      <ProcessingControls engine={denoiser} />
      </SettingsSection>}
      {section === 'recording' && <SettingsSection
        id="settings-recording"
        icon={<Monitor size={18} />}
        title="Recording quality"
        description="Choose how clear your saved screen recordings look."
      >
      <label className="grid gap-2">
        Screen recording bitrate
        <SettingsSelect
          ariaLabel="Screen recording bitrate"
          value={recordingRate}
          onValueChange={(next) => {
            const value = Number(next);
            setRecordingRate(value);
            writeStored('bc-recording-mbps', String(value));
          }}
          options={[10, 20, 40, 80].map((value) => ({ value, label: `${value} Mbps` }))}
        />
      </label>
      <p className="my-4 rounded-lg border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
        Higher quality keeps text and motion sharper, but uses more storage.
      </p>
      </SettingsSection>}
      {section === 'stream' && <SettingsSection
        id="settings-stream"
        icon={<Monitor size={18} />}
        title="Stream quality"
        description="Choose how sharp and smooth your shares can be."
      >
      <div className="grid gap-3.5">
        <label className="grid gap-2">
          Video bitrate ceiling
          <SettingsSelect
            ariaLabel="Video bitrate ceiling"
            value={quality.maxVideoBitrate}
            onValueChange={(value) =>
              change({ ...quality, maxVideoBitrate: Number(value) })
            }
            options={[{ value: 4_000_000, label: 'Data saver' }, { value: 10_000_000, label: 'Balanced' }, { value: 20_000_000, label: 'High quality' }, { value: 40_000_000, label: 'Maximum detail' }]}
          />
        </label>
        <label className="grid gap-2">
          Frame rate ceiling
          <SettingsSelect
            ariaLabel="Frame rate ceiling"
            value={quality.maxFramerate}
            onValueChange={(value) =>
              change({ ...quality, maxFramerate: Number(value) })
            }
            options={[{ value: 15, label: '15 FPS · text' }, { value: 30, label: '30 FPS · balanced' }, { value: 60, label: '60 FPS · smooth' }, { value: 120, label: '120 FPS · high refresh' }]}
          />
        </label>
        <label className="grid gap-2">
          Audio bitrate ceiling
          <SettingsSelect
            ariaLabel="Audio bitrate ceiling"
            value={quality.maxAudioBitrate}
            onValueChange={(value) =>
              change({ ...quality, maxAudioBitrate: Number(value) })
            }
            options={[{ value: 64_000, label: 'Voice' }, { value: 128_000, label: 'Balanced' }, { value: 256_000, label: 'High fidelity' }, { value: 510_000, label: 'Maximum' }]}
          />
        </label>
      </div>
      <p className="my-4 rounded-lg border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
        BetterComms will ease the quality down automatically when a connection needs it.
      </p>
      </SettingsSection>}
      {section === 'connection' && <SettingsSection
        id="settings-connection"
        icon={<Radio size={18} />}
        title="Connection"
        description="Change this only if you have trouble joining calls."
      >
      <SettingRow
        as="div"
        title="Direct connections only"
        description="Skip media relays. Some networks may not connect."
        control={<Switch
          aria-label="Direct connections only"
          checked={direct}
          onCheckedChange={(checked) => {
            setDirect(checked);
            writeStored('bc-direct', String(checked));
          }}
        />}
      />
      <p className="text-xs leading-6 text-muted-foreground">
        Connection mode applies when you next join a call.
      </p>
      <label className="device-select grid gap-2">
        Voice route
        <SettingsSelect
          ariaLabel="Voice route"
          disabled={direct}
          value={voiceRoute}
          onValueChange={(value) => {
            setVoiceRoute(value);
            writeStored('bc-voice-route', value);
          }}
          options={[{ value: 'automatic', label: 'Automatic' }, { value: 'relay', label: 'Compatibility mode' }]}
        />
      </label>
      <p className="my-4 rounded-lg border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
        Automatic works best for most people. Try compatibility mode only when voice will not connect.
      </p>
      </SettingsSection>}
    </>
  );
}
