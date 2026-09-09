import { isTauri } from '@tauri-apps/api/core';
import { getCallPlaybackStatus } from '@/media/remoteAudio';
import { readProcessingSettings } from '@/media/processingSettings';
import { readSpeakingThreshold } from '@/media/speakingSensitivity';
import { saveRecordingAsset } from '@/media/recordingExport';
import type { MediaEngine, PeerMediaStats, RemoteTrack, MediaSourceKind } from '@/media';

/** Peer stats with the peer id replaced by an index, so no identity leaves the device. */
const anonymisePeers = (stats: PeerMediaStats[]) =>
  stats.map(({ peerId: _peerId, voiceRelay, ...peer }, index) => ({
    peer: index + 1,
    ...peer,
    voiceRelay: voiceRelay ? { state: voiceRelay.state } : undefined,
  }));

const describeTrack = (track: MediaStreamTrack) => ({
  enabled: track.enabled,
  muted: track.muted,
  readyState: track.readyState,
});

/**
 * The report copied to the clipboard from the connection panel. It carries
 * transport measurements only — no audio, video, addresses, or credentials.
 */
export function buildConnectionReport({
  serverRtt,
  stats,
  locals,
  remote,
}: {
  serverRtt: number | null;
  stats: PeerMediaStats[];
  locals: Map<MediaSourceKind, MediaStreamTrack>;
  remote: RemoteTrack[];
}) {
  return {
    version: 1,
    time: new Date().toISOString(),
    serverRtt,
    playback: getCallPlaybackStatus(),
    microphoneSettings: readProcessingSettings(),
    speakingIndicatorThresholdDb: readSpeakingThreshold(),
    peers: anonymisePeers(stats),
    localSources: [...locals].map(([source, track]) => ({
      source,
      ...describeTrack(track),
    })),
    remoteSources: remote.map(({ source, track }) => ({
      source,
      ...describeTrack(track),
    })),
  };
}

/** The fuller report saved to a file, including the state of every video element. */
export async function buildDiagnosticReport({
  serverRtt,
  stats,
  engine,
  workspace,
}: {
  serverRtt: number | null;
  stats: PeerMediaStats[];
  engine: MediaEngine | null;
  workspace: HTMLElement | null;
}) {
  const nativeVersion = isTauri()
    ? await import('@tauri-apps/api/app')
        .then((app) => app.getVersion())
        .catch(() => 'unknown')
    : undefined;
  return {
    version: 2,
    time: new Date().toISOString(),
    client: { native: isTauri(), nativeVersion, userAgent: navigator.userAgent },
    serverRtt,
    playback: getCallPlaybackStatus(),
    screen: await engine?.getScreenDiagnostics(),
    peers: anonymisePeers(stats),
    videoElements: [...(workspace?.querySelectorAll('video') ?? [])].map((video) => ({
      self: video.classList.contains('self-video'),
      readyState: video.readyState,
      paused: video.paused,
      width: video.videoWidth,
      height: video.videoHeight,
      currentTime: video.currentTime,
      errorCode: video.error?.code,
    })),
  };
}

/** Saves a report through the native file dialog, or the browser download path. */
export async function saveReport(report: unknown) {
  const file = {
    name: 'bettercomms-diagnostics-' + Date.now() + '.json',
    blob: new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  };
  if (isTauri()) {
    await saveRecordingAsset(file, new AbortController().signal, () => {});
    return;
  }
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
