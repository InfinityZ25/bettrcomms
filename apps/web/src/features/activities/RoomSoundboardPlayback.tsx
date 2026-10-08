import { useSyncExternalStore, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { AppDialog } from '@/components/app-dialog';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { useActiveCall } from '@/features/call/CallSessionContext';
import { signedAttachmentURL } from '@/features/chat/attachmentFiles';
import { readStored, writeStored } from '@/lib/storage';
import { api, type ChannelActivitySnapshot } from './activityApi';
import { subscribeActivityEvents } from './activityEvents';

const storedVolume = Number(readStored('bc-soundboard-volume') ?? 0.5);
let settings = {
  enabled: false,
  muted: readStored('bc-soundboard-muted') === 'true',
  volume: Number.isFinite(storedVolume)
    ? Math.max(0, Math.min(1, storedVolume))
    : 0.5,
  error: '',
};
const listeners = new Set<() => void>();
const playing = new Set<HTMLAudioElement>();
const blocked = new Set<HTMLAudioElement>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => settings;
function update(patch: Partial<typeof settings>) {
  settings = { ...settings, ...patch };
  for (const audio of playing) {
    audio.volume = settings.volume;
    audio.muted = settings.muted || !settings.enabled;
  }
  for (const listener of listeners) listener();
}
function enable() {
  update({ enabled: true, error: '' });
  // A blocked, already-loaded element is retried inside the trusted click.
  for (const audio of blocked)
    void audio.play().then(
      () => {
        blocked.delete(audio);
      },
      () =>
        update({
          error:
            'Audio is blocked. Preview a sound, then try Enable audio again.',
        }),
    );
}

export function SoundboardPlaybackSettings() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Room sounds</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Local playback only. This volume does not change microphones or
            recordings. Deafen silences room sounds.
          </p>
        </div>
        <Button
          size="sm"
          variant={current.enabled ? 'secondary' : 'outline'}
          onClick={() => {
            if (current.enabled) update({ enabled: false });
            else enable();
          }}
        >
          {current.enabled ? 'Audio enabled' : 'Enable audio'}
        </Button>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={current.muted}
          onChange={(event) => {
            const muted = event.target.checked;
            writeStored('bc-soundboard-muted', String(muted));
            update({ muted });
          }}
        />
        Mute soundboard
      </label>
      <label className="flex items-center gap-3 text-sm">
        <Volume2 size={16} />
        <span className="shrink-0">
          Volume {Math.round(current.volume * 100)}%
        </span>
        <input
          type="range"
          aria-label="Soundboard volume"
          min="0"
          max="1"
          step="0.05"
          value={current.volume}
          className="min-w-0 flex-1 accent-primary"
          onChange={(event) => {
            const volume = Number(event.target.value);
            writeStored('bc-soundboard-volume', String(volume));
            update({ volume });
          }}
        />
      </label>
      {current.error && (
        <p role="status" className="text-xs text-destructive">
          {current.error}
        </p>
      )}
    </div>
  );
}

export function SoundboardSettingsButton() {
  const [open, setOpen] = useState(false);
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Soundboard playback settings"
        onClick={() => setOpen(true)}
      >
        {current.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </Button>
      {open && (
        <AppDialog
          open
          onOpenChange={setOpen}
          title="Soundboard playback"
          description="Choose what you hear when friends play sounds in your voice channel."
        >
          <SoundboardPlaybackSettings />
        </AppDialog>
      )}
    </>
  );
}

export function ActiveCallSoundboardPlayback() {
  const call = useActiveCall();
  return call.joined && call.callRoom && !call.microphone.deafened ? (
    <RoomSoundboardPlayback key={call.callRoom.id} roomId={call.callRoom.id} />
  ) : null;
}

/** The listener outlives channel navigation, but never the active call. */
export function RoomSoundboardPlayback({ roomId }: { roomId: string }) {
  useMountEffect(() => {
    const lifetime = new AbortController();
    const owned = new Set<HTMLAudioElement>();
    const timers = new Map<HTMLAudioElement, ReturnType<typeof setTimeout>>();
    const seen = new Set<string>();
    let fetching = 0;
    function release(audio: HTMLAudioElement) {
      const timer = timers.get(audio);
      if (timer) clearTimeout(timer);
      timers.delete(audio);
      owned.delete(audio);
      playing.delete(audio);
      blocked.delete(audio);
      audio.onended = null;
      audio.onerror = null;
      audio.onplay = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    const off = subscribeActivityEvents((event) => {
      if (
        event.type !== 'soundboard.play' ||
        event.room_id !== roomId ||
        seen.has(event.event_id)
      )
        return;
      seen.add(event.event_id);
      if (seen.size > 128) seen.delete(seen.values().next().value!);
      if (
        !settings.enabled ||
        settings.muted ||
        Date.now() - Date.parse(event.played_at) > 10000 ||
        owned.size + fetching >= 3
      )
        return;
      fetching += 1;
      void (async () => {
        try {
          const data = await api<ChannelActivitySnapshot>(
            `/rooms/${roomId}/activities`,
            undefined,
            undefined,
            lifetime.signal,
          );
          const asset = data.assets.find(
            (candidate) =>
              candidate.id === event.asset_id && candidate.kind === 'sound',
          );
          if (
            !asset ||
            lifetime.signal.aborted ||
            !settings.enabled ||
            settings.muted
          )
            return;
          const url = await signedAttachmentURL(
            roomId,
            asset.attachment.id,
            lifetime.signal,
          );
          if (
            lifetime.signal.aborted ||
            !settings.enabled ||
            settings.muted ||
            Date.now() - Date.parse(event.played_at) > 10000
          )
            return;
          const audio = new Audio(url);
          owned.add(audio);
          playing.add(audio);
          audio.volume = settings.volume;
          audio.muted = settings.muted;
          audio.preload = 'auto';
          audio.onended = () => release(audio);
          audio.onerror = () => {
            release(audio);
            update({
              error:
                'This sound could not play. Check its audio format or try again.',
            });
          };
          audio.onplay = () => {
            const previous = timers.get(audio);
            if (previous) clearTimeout(previous);
            timers.set(
              audio,
              setTimeout(
                () => release(audio),
                Math.min(30000, (asset.duration_ms ?? 30000) + 500),
              ),
            );
          };
          // Bounded lifetime also applies to an autoplay-blocked element.
          timers.set(
            audio,
            setTimeout(() => release(audio), 30000),
          );
          const output = readStored('bc-output');
          if (output && 'setSinkId' in audio)
            await audio
              .setSinkId(output)
              .catch(() =>
                update({
                  error: 'Soundboard is playing on the default audio output.',
                }),
              );
          if (lifetime.signal.aborted) {
            release(audio);
            return;
          }
          await audio.play().catch((error: unknown) => {
            if (lifetime.signal.aborted) return;
            if (
              error instanceof DOMException &&
              error.name === 'NotAllowedError'
            ) {
              blocked.add(audio);
              update({ error: 'Enable soundboard audio to hear this sound.' });
            } else {
              release(audio);
              update({ error: 'This sound could not play.' });
            }
          });
        } catch (error) {
          if (!lifetime.signal.aborted)
            update({
              error:
                error instanceof Error
                  ? error.message
                  : 'Could not play room sound.',
            });
        } finally {
          fetching -= 1;
        }
      })();
    });
    const unlock = () => enable();
    window.addEventListener('bc-audio-unlock', unlock);
    return () => {
      lifetime.abort();
      off();
      window.removeEventListener('bc-audio-unlock', unlock);
      for (const audio of [...owned]) release(audio);
    };
  });
  return null;
}
