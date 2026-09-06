import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface FfmpegInstallInfo {
  supported: boolean;
  installed: boolean;
  downloadBytes: number;
  installedBytes: number;
  detail: string;
}

export default function NativeFfmpegSetup({
  onInstalled,
  onUseBrowser,
}: {
  onInstalled(): void | Promise<void>;
  onUseBrowser(): void | Promise<void>;
}) {
  const [info, setInfo] = useState<FfmpegInstallInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setInfo(await invoke<FfmpegInstallInfo>('ffmpeg_install_info'));
  }

  useEffect(() => {
    void refresh().catch((cause) => {
      const message = String(cause);
      if (/not found|not allowed|unknown command/i.test(message)) {
        setError('Update to BetterComms 0.1.1 or newer to use the in-app installer. Browser sharing is available below.');
        setInfo({ supported: false, installed: false, downloadBytes: 0, installedBytes: 0, detail: 'This desktop version needs an update for guided setup.' });
      } else setError(message);
    });
  }, []);

  async function install() {
    setBusy(true);
    setError('');
    try {
      await invoke('ffmpeg_install');
      await refresh();
      await onInstalled();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setting-note" role="status">
      <p>{info?.detail ?? 'Checking the native sharing runtime…'}</p>
      {info?.supported && !info.installed && (
        <>
          <p>
            Setup downloads a verified {Math.round(info.downloadBytes / 1024 / 1024)} MiB
            FFmpeg 8.1 package and keeps the {Math.round(info.installedBytes / 1024 / 1024)} MiB
            runtime in BetterComms app storage. It does not change Windows or your PATH.
          </p>
          <button className="text-button" disabled={busy} onClick={() => void install()}>
            {busy ? 'Installing native sharing runtime…' : error ? 'Retry runtime setup' : 'Install native sharing runtime'}
          </button>
        </>
      )}
      <button className="text-button" disabled={busy} onClick={() => void onUseBrowser()}>
        Use browser sharing
      </button>
      {error && <p>Runtime setup failed: {error}</p>}
    </div>
  );
}
