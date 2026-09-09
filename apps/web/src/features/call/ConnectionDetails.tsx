import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { MediaSourceKind, PeerMediaStats, RemoteTrack, MediaEngine } from '@/media';
import {
  buildConnectionReport,
  buildDiagnosticReport,
  saveReport,
} from './diagnostics';

const routeLabel = (route: PeerMediaStats['route']) =>
  route?.localCandidateType === 'relay' || route?.remoteCandidateType === 'relay'
    ? 'Relay'
    : route
      ? 'Direct'
      : 'Route pending';

/** The expandable transport measurements, plus the two report exports. */
export default function ConnectionDetails({
  serverRtt,
  stats,
  names,
  locals,
  remote,
  engine,
  workspace,
}: {
  serverRtt: number | null;
  stats: PeerMediaStats[];
  names: Record<string, string>;
  locals: Map<MediaSourceKind, MediaStreamTrack>;
  remote: RemoteTrack[];
  engine: MediaEngine | null;
  workspace: HTMLElement | null;
}) {
  const [status, setStatus] = useState('');

  const download = async () => {
    try {
      await saveReport(await buildDiagnosticReport({ serverRtt, stats, engine, workspace }));
      setStatus(
        'Diagnostics exported. No call content, addresses, or credentials included.',
      );
    } catch {
      setStatus('Could not export diagnostics. Try again while the call is open.');
    }
  };

  const copy = () => {
    const report = buildConnectionReport({ serverRtt, stats, locals, remote });
    void navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(
      () =>
        setStatus(
          'Connection report copied. No audio, video, addresses, or credentials included.',
        ),
      () => setStatus('Could not copy. Allow clipboard access and try again.'),
    );
  };

  return (
    <div className="stats-panel">
      <strong>Connection details</strong>
      <Button variant="secondary" onClick={() => void download()}>
        Download diagnostic report
      </Button>
      <Button variant="secondary" onClick={copy}>
        Copy connection report
      </Button>
      {status && <small role="status">{status}</small>}
      {stats.length ? (
        stats.map((peer) => (
          <div key={peer.peerId}>
            <span>
              {names[peer.peerId] ?? 'Friend'} · {peer.connectionState} ·{' '}
              {routeLabel(peer.route)} ·{' '}
              {peer.route?.currentRoundTripTimeMs?.toFixed(0) ?? '—'} ms RTT
            </span>
            {peer.tracks.map((track, index) => (
              <small key={index}>
                {track.direction === 'outbound' ? 'Sending' : 'Receiving'}{' '}
                {track.source ?? track.mediaKind}
                {track.source === 'screen' && track.screenTransport
                  ? ` (${track.screenTransport === 'native-compatibility' ? 'native compatibility' : 'browser WebRTC'})`
                  : ''}
                : {(track.bitrate / 1000).toFixed(0)} kbps{' '}
                {track.width
                  ? `· ${track.width}×${track.height} · ${track.framesPerSecond ?? '—'} FPS`
                  : ''}
              </small>
            ))}
            {peer.nativeScreen && (
              <small>
                Native screen: {peer.nativeScreen.connectionState} ·{' '}
                {peer.nativeScreen.framesDecoded} decoded frames ·{' '}
                {(peer.nativeScreen.bytesReceived / 1024).toFixed(0)} KB received ·{' '}
                {peer.nativeScreen.codec ?? 'codec pending'}
              </small>
            )}
          </div>
        ))
      ) : (
        <p>Media measurements appear when a friend connects.</p>
      )}
    </div>
  );
}
