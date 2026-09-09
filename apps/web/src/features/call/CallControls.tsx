import {
  Circle,
  Headphones,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Square,
  Video,
  VideoOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The microphone, headphones, camera, share, record and leave row. */
export default function CallControls({
  joined,
  busy,
  signedIn,
  muted,
  manualMuted,
  deafened,
  cameraOn,
  sharing,
  recording,
  onToggleMute,
  onToggleDeafen,
  onToggleCamera,
  onToggleShare,
  onToggleRecord,
  onLeave,
  onJoin,
}: {
  joined: boolean;
  busy: boolean;
  signedIn: boolean;
  muted: boolean;
  manualMuted: boolean;
  deafened: boolean;
  cameraOn: boolean;
  sharing: boolean;
  recording: boolean;
  onToggleMute(): void;
  onToggleDeafen(): void;
  onToggleCamera(): void;
  onToggleShare(): void;
  onToggleRecord(): void;
  onLeave(): void;
  onJoin(): void;
}) {
  return (
    <div className="call-controls">
      <Button
        variant={muted ? 'danger' : 'secondary'}
        size="icon"
        aria-label={
          deafened
            ? 'Microphone muted while deafened'
            : manualMuted
              ? 'Unmute microphone'
              : 'Mute microphone'
        }
        onClick={onToggleMute}
        disabled={deafened}
      >
        {muted ? <MicOff size={19} /> : <Mic size={19} />}
      </Button>
      <Button
        variant={deafened ? 'danger' : 'secondary'}
        size="icon"
        aria-label={deafened ? 'Undeafen call' : 'Deafen call'}
        onClick={onToggleDeafen}
      >
        <Headphones size={19} />
      </Button>
      <Button
        variant={cameraOn ? 'default' : 'secondary'}
        size="icon"
        aria-label={cameraOn ? 'Turn off camera' : 'Turn on camera'}
        onClick={onToggleCamera}
        disabled={busy}
      >
        {cameraOn ? <Video size={19} /> : <VideoOff size={19} />}
      </Button>
      {joined ? (
        <>
          <Button
            variant={sharing ? 'default' : 'secondary'}
            size="icon"
            aria-label={sharing ? 'Stop sharing' : 'Share screen'}
            onClick={onToggleShare}
            disabled={busy}
          >
            <MonitorUp size={19} />
          </Button>
          <Button
            variant={recording ? 'danger' : 'secondary'}
            size="icon"
            aria-label={recording ? 'Stop recording' : 'Record separate tracks'}
            onClick={onToggleRecord}
            disabled={busy}
          >
            {recording ? <Square size={16} /> : <Circle size={17} />}
          </Button>
          <Button variant="danger" onClick={onLeave}>
            <PhoneOff size={18} /> Leave call
          </Button>
        </>
      ) : (
        <Button onClick={onJoin} disabled={busy}>
          <Headphones size={18} />
          {busy ? 'Connecting…' : signedIn ? 'Join call' : 'Sign in to join'}
        </Button>
      )}
    </div>
  );
}
