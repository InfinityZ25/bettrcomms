import { useRef, useState } from 'react';
import { Plus, Play, Send, Trash2 } from 'lucide-react';
import { api, type Room, type User, type Message } from '@/api';
import { Button } from '@/components/ui/button';
import { useLifetimeSignal } from '@/hooks/useLifetimeSignal';
import { useMountEffect } from '@/hooks/useMountEffect';
import {
  discardPendingAttachment,
  signedAttachmentURL,
  uploadAttachmentWithProgress,
} from '@/features/chat/attachmentFiles';
import { receiveMessage } from '@/features/chat/messageStore';
import { useCallPresence } from '@/features/call/useCallPresence';
import type { ChannelMediaAsset } from './activityApi';
import type { ActivityAction } from './PollsPanel';
import { SoundboardPlaybackSettings } from './RoomSoundboardPlayback';
import { audioFileDuration } from './audioFileDuration';
import { MediaAssetUploadForm } from './MediaAssetUploadForm';

function AssetImage({
  roomId,
  asset,
}: {
  roomId: string;
  asset: ChannelMediaAsset;
}) {
  const [url, setURL] = useState('');
  const [error, setError] = useState(false);
  const lifetime = useLifetimeSignal();
  async function load() {
    const signal = lifetime();
    try {
      const value = await signedAttachmentURL(
        roomId,
        asset.attachment.id,
        signal,
      );
      if (!signal.aborted) {
        setURL(value);
        setError(false);
      }
    } catch {
      if (!signal.aborted) setError(true);
    }
  }
  useMountEffect(() => {
    void load();
  });
  return error ? (
    <Button variant="ghost" size="sm" onClick={() => void load()}>
      Load preview
    </Button>
  ) : (
    <img
      src={url || undefined}
      alt={asset.name}
      className="h-24 w-full object-contain"
      loading="lazy"
      onError={() => setError(true)}
    />
  );
}

export function MediaAssetsPanel({
  kind,
  assets,
  room,
  user,
  busy,
  act,
  refresh,
}: {
  kind: 'sticker' | 'sound';
  assets: ChannelMediaAsset[];
  room: Room;
  user: User;
  busy: boolean;
  act: ActivityAction;
  refresh: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [sending, setSending] = useState('');
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const pendingSends = useRef(new Map<string, string>());
  const sendInFlight = useRef(false);
  const lifetime = useLifetimeSignal();
  const presence = useCallPresence(user.id);
  const inVoice =
    presence.rooms[room.id]?.some(
      (participant) => participant.user_id === user.id,
    ) ?? false;
  const canPost = room.permissions?.post ?? room.can_post ?? true;
  const items = assets.filter((asset) => asset.kind === kind);
  const uploading = progress !== null;
  async function create() {
    if (!file || uploading || busy) return;
    const signal = lifetime();
    setProgress(0);
    setError('');
    let pending: string | undefined;
    let claimed = false;
    try {
      if (file.size > (kind === 'sticker' ? 5 : 2) * 1024 * 1024)
        throw new Error(
          kind === 'sticker'
            ? 'Stickers can be up to 5 MB.'
            : 'Sounds can be up to 2 MB.',
        );
      const duration =
        kind === 'sound' ? await audioFileDuration(file, signal) : null;
      const attachment = await uploadAttachmentWithProgress(room.id, file, {
        signal,
        onProgress: (value) => {
          if (!signal.aborted) setProgress(value);
        },
      });
      pending = attachment.id;
      await api(
        `/rooms/${room.id}/media-assets`,
        {
          name: name.trim(),
          kind,
          attachment_id: attachment.id,
          duration_ms: duration,
        },
        'POST',
        signal,
      );
      claimed = true;
      if (!signal.aborted) {
        setCreating(false);
        setFile(null);
        setName('');
        if (picker.current) picker.current.value = '';
        await refresh();
      }
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not add this room asset.',
        );
    } finally {
      if (pending && !claimed && !signal.aborted)
        void discardPendingAttachment(room.id, pending, signal).catch(() => {});
      if (!signal.aborted) setProgress(null);
    }
  }
  async function send(asset: ChannelMediaAsset) {
    if (sendInFlight.current || uploading || busy) return;
    sendInFlight.current = true;
    const signal = lifetime();
    setSending(asset.id);
    setError('');
    try {
      const result = await api<{ message: Message }>(
        `/rooms/${room.id}/media-assets/${asset.id}/send`,
        {
          nonce:
            pendingSends.current.get(asset.id) ??
            (() => {
              const nonce = crypto.randomUUID();
              pendingSends.current.set(asset.id, nonce);
              return nonce;
            })(),
        },
        'POST',
        signal,
      );
      if (!signal.aborted) {
        pendingSends.current.delete(asset.id);
        receiveMessage(user.id, result.message);
      }
    } catch (failure) {
      if (!signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not send this sticker.',
        );
    } finally {
      sendInFlight.current = false;
      if (!signal.aborted) setSending('');
    }
  }
  return (
    <div className="space-y-4">
      {kind === 'sound' && <SoundboardPlaybackSettings />}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {kind === 'sticker'
            ? 'Images shared by your friends. Send one straight into this channel.'
            : 'Play a short sound for people in this channel’s voice call.'}
        </p>
        {canPost && items.length < 100 && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || uploading}
            onClick={() => setCreating(!creating)}
          >
            <Plus size={15} />
            Add {kind === 'sticker' ? 'sticker' : 'sound'}
          </Button>
        )}
      </div>
      {creating && (
        <MediaAssetUploadForm
          kind={kind}
          name={name}
          file={file}
          progress={progress}
          busy={busy}
          picker={picker}
          onName={setName}
          onFile={setFile}
          onCancel={() => setCreating(false)}
          onCreate={create}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {kind === 'sound' && !inVoice && (
        <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          Join this channel’s voice call to use its soundboard.
        </p>
      )}
      {!items.length && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No {kind === 'sticker' ? 'stickers' : 'sounds'} yet. Add something
          your friends will recognize.
        </p>
      )}
      <ul
        className={`grid gap-3 ${kind === 'sticker' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}`}
      >
        {items.map((asset) => (
          <li
            key={asset.id}
            className="flex flex-col gap-2 rounded-xl border p-3"
          >
            {kind === 'sticker' && (
              <AssetImage
                key={asset.attachment.id}
                roomId={room.id}
                asset={asset}
              />
            )}
            <strong className="truncate text-sm" title={asset.name}>
              {asset.name}
            </strong>
            {kind === 'sound' && (
              <span className="text-xs text-muted-foreground">
                {((asset.duration_ms ?? 0) / 1000).toFixed(1)} seconds
              </span>
            )}
            <div className="mt-auto flex items-center gap-1">
              {kind === 'sticker' ? (
                <Button
                  className="flex-1"
                  variant="secondary"
                  size="sm"
                  disabled={!canPost || busy || uploading || Boolean(sending)}
                  onClick={() => void send(asset)}
                >
                  <Send size={14} />
                  {sending === asset.id ? 'Sending…' : 'Send'}
                </Button>
              ) : (
                <Button
                  className="flex-1"
                  variant="secondary"
                  size="sm"
                  disabled={
                    !inVoice ||
                    !room.permissions?.join_voice ||
                    busy ||
                    uploading
                  }
                  onClick={() =>
                    void act(`/media-assets/${asset.id}/play`, {}, 'POST')
                  }
                >
                  <Play size={14} />
                  Play
                </Button>
              )}
              {canPost &&
                (asset.creator_id === user.id ||
                  room.permissions?.moderate) && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${asset.name}`}
                    disabled={busy || uploading || Boolean(sending)}
                    onClick={() =>
                      void act(`/media-assets/${asset.id}`, undefined, 'DELETE')
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
