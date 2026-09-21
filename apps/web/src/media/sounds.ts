import { readStored, writeStored } from '@/lib/storage';

/**
 * The app's sounds.
 *
 * Played through Web Audio rather than an `<audio>` element, which is not a
 * detail: Chromium treats a playing media element as the page's media session,
 * so the play/pause key on a keyboard — or a headset button — would start
 * whichever of these had sounded last. A decoded buffer on an AudioContext is
 * not media anybody can transport-control, which is right for a doorbell.
 *
 * Files live in public/sounds and are fetched and decoded on first use, then
 * kept. Every failure is swallowed: a browser refuses audio before the page has
 * been interacted with, and a sound that cannot play is not worth an error.
 */
const files = {
  join: 'join_call',
  leave: 'left_call',
  notification: 'notification',
  ringtone: 'ringtone',
  share: 'screen_share',
} as const;

export type SoundName = keyof typeof files;

export const soundNames = Object.keys(files) as SoundName[];

/** What each one is for, where a person is choosing whether to hear it. */
export const soundLabels: Record<SoundName, { title: string; description: string }> = {
  join: {
    title: 'Someone joins',
    description: 'You entering a call, and anyone arriving while you are in it.',
  },
  leave: {
    title: 'Someone leaves',
    description: 'You hanging up, and anyone leaving the call around you.',
  },
  share: {
    title: 'A screen goes up',
    description: 'Somebody starts sharing while you are in the call.',
  },
  notification: {
    title: 'New message',
    description: 'A message in a conversation you are not looking at.',
  },
  ringtone: {
    title: 'Incoming call',
    description: 'Rings while a call you could join is running without you.',
  },
};

const ENABLED_KEY = 'bc-sounds';
const VOLUME_KEY = 'bc-sound-volume';
const soundKey = (name: SoundName) => `bc-sound-${name}`;

/** Everything is on until it is turned off; the switches are in Audio settings. */
export function soundsEnabled() {
  return readStored(ENABLED_KEY) !== 'off';
}

export function soundEnabled(name: SoundName) {
  return soundsEnabled() && readStored(soundKey(name)) !== 'off';
}

/** Loud enough to notice from the next room without startling anyone. */
const DEFAULT_VOLUME = 0.45;

/** 0 to 1, where 0 is a deliberate choice and a missing value is not. */
export function soundVolume() {
  const stored = readStored(VOLUME_KEY);
  if (stored === null) return DEFAULT_VOLUME;
  const value = Number(stored);
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : DEFAULT_VOLUME;
}

function announce() {
  window.dispatchEvent(new Event('bc-sounds'));
}

export function setSoundsEnabled(enabled: boolean) {
  writeStored(ENABLED_KEY, enabled ? 'on' : 'off');
  if (!enabled) stopSound('ringtone');
  announce();
}

export function setSoundEnabled(name: SoundName, enabled: boolean) {
  writeStored(soundKey(name), enabled ? 'on' : 'off');
  if (!enabled && name === 'ringtone') stopSound('ringtone');
  announce();
}

export function setSoundVolume(value: number) {
  const level = Math.min(1, Math.max(0, value));
  writeStored(VOLUME_KEY, String(level));
  if (gain) gain.gain.value = level;
  announce();
}

let context: AudioContext | null = null;
let gain: GainNode | null = null;
const buffers = new Map<SoundName, Promise<AudioBuffer | null>>();
const playing = new Map<SoundName, AudioBufferSourceNode>();

function audio() {
  if (!context) {
    try {
      context = new AudioContext();
      gain = context.createGain();
      gain.gain.value = soundVolume();
      gain.connect(context.destination);
    } catch {
      return null;
    }
  }
  // Created before the first click, a context starts suspended and stays that
  // way until something resumes it.
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return context;
}

function load(name: SoundName) {
  let pending = buffers.get(name);
  if (!pending) {
    pending = fetch(`/sounds/${files[name]}.wav`)
      .then((response) => response.arrayBuffer())
      .then((bytes) => context!.decodeAudioData(bytes))
      .catch(() => null);
    buffers.set(name, pending);
  }
  return pending;
}

/**
 * Two requests for the same sound this close together are one event.
 *
 * A switch that reports its change through both a click and an input event, or
 * two people arriving in the same signalling frame, would otherwise restart the
 * sound on top of itself and flam.
 */
const REPEAT_GUARD = 120;
const lastStarted = new Map<SoundName, number>();

function start(name: SoundName, loop: boolean) {
  if (!soundEnabled(name)) return;
  const now = performance.now();
  if (!loop && now - (lastStarted.get(name) ?? -Infinity) < REPEAT_GUARD) return;
  lastStarted.set(name, now);
  const ctx = audio();
  if (!ctx || !gain) return;
  void load(name).then((buffer) => {
    // Checked again on the way out: loading is async, and the switch may have
    // been turned off, or the ringtone stopped, while the file was in flight.
    if (!buffer || !soundEnabled(name) || !context || !gain) return;
    if (loop && playing.has(name)) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    source.connect(gain);
    source.onended = () => {
      if (playing.get(name) === source) playing.delete(name);
    };
    playing.get(name)?.stop();
    playing.set(name, source);
    gain.gain.value = soundVolume();
    source.start();
  });
}

/** One shot. */
export function playSound(name: SoundName) {
  start(name, false);
}

/** For the ringtone, which rings until something happens. */
export function loopSound(name: SoundName) {
  start(name, true);
}

export function stopSound(name: SoundName) {
  const source = playing.get(name);
  if (!source) return;
  playing.delete(name);
  try {
    source.stop();
  } catch {
    // Already finished.
  }
}

/** Lets the settings screen play the one being adjusted. */
export function previewSound(name: SoundName) {
  if (name === 'ringtone') {
    // A loop would keep ringing after the switch was let go.
    start('ringtone', false);
    return;
  }
  start(name, false);
}
