import { AudioLeveler } from './audio';
import { followOutputDevice } from './output';

type PlaybackState = {
  context: AudioContext;
  limiter: DynamicsCompressorNode;
  stopOutput: () => void;
  references: number;
};

let playback: PlaybackState | null = null;

export function getCallPlaybackStatus() {
  return { state: playback?.context.state ?? 'inactive', tracks: playback?.references ?? 0, customOutputSelected: Boolean(localStorage.getItem('bc-output')) };
}

function report(name: 'bc-audio-blocked' | 'bc-output-error', detail?: string) {
  window.dispatchEvent(
    detail ? new CustomEvent(name, { detail }) : new Event(name),
  );
}

function resume(context: AudioContext): void {
  if (context.state !== 'suspended') return;
  void context.resume().then(() => {
    if (context.state === 'suspended') report('bc-audio-blocked');
  }, () => report('bc-audio-blocked'));
}

function getPlayback(): PlaybackState {
  if (playback && playback.context.state !== 'closed') return playback;

  const context = new AudioContext({ latencyHint: 'interactive' });
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.connect(context.destination);
  playback = {
    context,
    limiter,
    references: 0,
    stopOutput: followOutputDevice(context, (error) =>
      report('bc-output-error', error.message),
    ),
  };
  context.addEventListener('statechange', () => {
    if (context.state === 'suspended') report('bc-audio-blocked');
  });
  return playback;
}

/** Call synchronously from the Join click so autoplay permission survives later awaits. */
export function prepareCallPlayback(): void {
  try {
    resume(getPlayback().context);
  } catch (error) {
    report(
      'bc-output-error',
      error instanceof Error ? error.message : 'Audio output is unavailable.',
    );
  }
}

/** Releases the shared call output graph. Call after leaving a room. */
export function disposeCallPlayback(): void {
  const current = playback;
  playback = null;
  if (!current) return;
  current.stopOutput();
  current.limiter.disconnect();
  if (current.context.state !== 'closed') void current.context.close();
}

export function readParticipantVolume(peerId: string): number {
  const value = Number(localStorage.getItem(`bc-volume-${peerId}`) ?? 1);
  return Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 1;
}

export function attachRemoteAudio({
  track,
  peerId,
  balanceVoice,
}: {
  track: MediaStreamTrack;
  peerId: string;
  balanceVoice: boolean;
}): () => void {
  let current: PlaybackState;
  try {
    current = getPlayback();
  } catch (error) {
    report(
      'bc-output-error',
      error instanceof Error ? error.message : 'Audio output is unavailable.',
    );
    return attachElementFallback(track, peerId);
  }

  const { context, limiter } = current;
  current.references += 1;
  const stream = new MediaStream([track]);
  const gain = context.createGain();
  gain.gain.value = readParticipantVolume(peerId);
  gain.connect(limiter);
  let input: MediaStreamAudioSourceNode | null = null;
  let leveler: AudioLeveler | null = null;
  try {
    if (balanceVoice) leveler = new AudioLeveler(stream, gain);
    else {
      input = context.createMediaStreamSource(stream);
      input.connect(gain);
    }
  } catch (error) {
    gain.disconnect();
    current.references -= 1;
    report(
      'bc-output-error',
      error instanceof Error ? error.message : 'Could not connect remote audio.',
    );
    return attachElementFallback(track, peerId);
  }

  const unlock = () => resume(context);
  unlock();
  const blockedCheck = setTimeout(() => {
    if (context.state === 'suspended') report('bc-audio-blocked');
  }, 700);
  window.addEventListener('bc-audio-unlock', unlock);
  // A real click/key is also a retry, so callers do not depend on an extra UI step.
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
  const volume = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { peerId?: unknown; volume?: unknown }
      | undefined;
    if (detail?.peerId !== peerId) return;
    const value = Number(detail.volume);
    const normalized = Number.isFinite(value)
      ? Math.min(2, Math.max(0, value))
      : 1;
    gain.gain.setTargetAtTime(normalized, context.currentTime, 0.02);
  };
  window.addEventListener('bc-volume', volume);

  return () => {
    clearTimeout(blockedCheck);
    window.removeEventListener('bc-volume', volume);
    window.removeEventListener('bc-audio-unlock', unlock);
    window.removeEventListener('pointerdown', unlock, { capture: true });
    window.removeEventListener('keydown', unlock, { capture: true });
    leveler?.dispose();
    input?.disconnect();
    gain.disconnect();
    current.references = Math.max(0, current.references - 1);
  };
}

function attachElementFallback(track: MediaStreamTrack, peerId: string): () => void {
  const element = document.createElement('audio');
  element.autoplay = true;
  element.setAttribute('playsinline', '');
  element.srcObject = new MediaStream([track]);
  element.volume = Math.min(1, readParticipantVolume(peerId));
  element.hidden = true;
  document.body.append(element);
  const stopOutput = followOutputDevice(element, (error) =>
    report('bc-output-error', error.message),
  );
  const play = () => {
    void element.play().catch(() => report('bc-audio-blocked'));
  };
  const volume = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { peerId?: unknown; volume?: unknown }
      | undefined;
    if (detail?.peerId !== peerId) return;
    const value = Number(detail.volume);
    element.volume = Number.isFinite(value)
      ? Math.min(1, Math.max(0, value))
      : 1;
  };
  play();
  window.addEventListener('bc-audio-unlock', play);
  window.addEventListener('pointerdown', play, { capture: true });
  window.addEventListener('keydown', play, { capture: true });
  window.addEventListener('bc-volume', volume);
  return () => {
    stopOutput();
    window.removeEventListener('bc-audio-unlock', play);
    window.removeEventListener('pointerdown', play, { capture: true });
    window.removeEventListener('keydown', play, { capture: true });
    window.removeEventListener('bc-volume', volume);
    element.pause();
    element.srcObject = null;
    element.remove();
  };
}
