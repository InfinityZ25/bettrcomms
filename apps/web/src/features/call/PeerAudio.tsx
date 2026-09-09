import { useEffect, useState } from 'react';
import { attachRemoteAudio, readParticipantVolume } from '@/media/remoteAudio';
import type { MediaSourceKind, RemoteTrack } from '@/media';
import { writeStored } from '@/lib/storage';

/** Routes one remote track into the call's playback graph for as long as it exists. */
export function RemoteAudio({
  track,
  peerId,
  source,
  balanced,
}: {
  track: MediaStreamTrack;
  peerId: string;
  source: MediaSourceKind;
  balanced: boolean;
}) {
  useEffect(
    () =>
      attachRemoteAudio({
        track,
        peerId,
        balanceVoice: balanced && source === 'microphone',
      }),
    [track, peerId, source, balanced],
  );
  return null;
}

/** Per-participant volume. Playback reads the change from the event, not a prop. */
export function PeerVolume({
  peerId,
  remote,
  balanced,
}: {
  peerId: string;
  remote: RemoteTrack[];
  balanced: boolean;
}) {
  const [volume, setVolume] = useState(() => readParticipantVolume(peerId));
  return (
    <label>
      Volume {Math.round(volume * 100)}%
      <input
        aria-label="Participant volume"
        type="range"
        min="0"
        max="2"
        step="0.05"
        value={volume}
        onChange={(event) => {
          const value = Number(event.target.value);
          setVolume(value);
          writeStored('bc-volume-' + peerId, String(value));
          window.dispatchEvent(
            new CustomEvent('bc-volume', { detail: { peerId, volume: value } }),
          );
        }}
      />
      <small>
        {balanced
          ? 'Voice balancing on'
          : `${remote.filter((track) => track.peerId === peerId).length} media tracks`}
      </small>
    </label>
  );
}
