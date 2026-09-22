import { errorMessage } from '@/lib/errors';
import { LinkButton } from '@/components/ui/link-button';
import { useEffect, useState } from 'react';
import { invokeAudioSetup } from '@/desktop/audio';

export interface DeepfilterStatus {
  ready: boolean;
  detail: string;
  adapterName: string | null;
  frameSamples: number | null;
  sampleRate: number;
}

interface DeepfilterInstallInfo {
  supported: boolean;
  installed: boolean;
  downloadBytes: number;
  detail: string;
}

export default function NativeDeepfilterSetup({
  onStatus,
}: {
  onStatus(status: DeepfilterStatus): void;
}) {
  const [status, setStatus] = useState<DeepfilterStatus | null>(null);
  const [info, setInfo] = useState<DeepfilterInstallInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      const [nextStatus, nextInfo] = await Promise.all([
        invokeAudioSetup<DeepfilterStatus>('deepfilter_status'),
        invokeAudioSetup<DeepfilterInstallInfo>('deepfilter_install_info'),
      ]);
      setStatus(nextStatus);
      setInfo(nextInfo);
      onStatus(nextStatus);
    } catch (cause) {
      const detail = errorMessage(cause);
      const unavailable = {
        ready: false,
        detail,
        adapterName: null,
        frameSamples: null,
        sampleRate: 48_000,
      };
      setStatus(unavailable);
      setInfo(null);
      onStatus(unavailable);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function install() {
    if (!info?.supported) return;
    setBusy(true);
    setError('');
    try {
      await invokeAudioSetup('deepfilter_install');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  if (!status) return null;
  if (status.ready)
    return (
      <p className="text-xs leading-6 text-muted-foreground">
        DeepFilterNet is ready
        {status.adapterName ? ` on ${status.adapterName}` : ''}. {status.detail}
      </p>
    );
  return (
    <div className="my-4 rounded-lg border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
      <p>DeepFilterNet is unavailable: {status.detail}</p>
      {info && <p>{info.detail}</p>}
      {info?.supported && (
        <>
          <p>
            Setup downloads an optional{' '}
            {Math.round(info.downloadBytes / 1024 / 1024)} MiB component and
            processes microphone audio on your local AMD or Intel GPU.
          </p>
          <LinkButton
            disabled={busy}
            onClick={install}
          >
            {busy
              ? 'Installing DeepFilterNet…'
              : error
                ? 'Retry DeepFilterNet setup'
                : 'Download and set up DeepFilterNet'}
          </LinkButton>
        </>
      )}
      {info && !info.supported && (
        <p>DeepFilterNet setup is unavailable on this device.</p>
      )}
      {error && <p>DeepFilterNet setup failed: {error}</p>}
    </div>
  );
}
