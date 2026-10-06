import { useRef, useState, type RefObject } from 'react';
import { Mic, Square, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMountEffect } from '@/hooks/useMountEffect';
import { readDesktopBootReport } from '@/desktop/runtime';
import { openDesktopPrivacySettings } from '@/media/permissions';
import { errorMessage } from '@/lib/errors';
import { VoiceNoteRecorder, voiceNoteTime, type VoiceNoteState } from './voiceNoteRecorder';

function VoiceNoteReview({ file, durationMs }: { file: File; durationMs: number }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState('');
  useMountEffect(() => {
    const objectURL = URL.createObjectURL(file);
    const element = audio.current;
    setUrl(objectURL);
    return () => {
      if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
      URL.revokeObjectURL(objectURL);
    };
  });
  return <div className="min-w-0 basis-full"><p className="text-xs font-medium">Review voice note · {voiceNoteTime(durationMs)}</p><audio ref={audio} src={url || undefined} controls preload="none" aria-label="Preview your voice note" className="mt-2 h-9 w-full max-w-full" /></div>;
}

function InterruptRestrictedCapture({ recorder }: { recorder: RefObject<VoiceNoteRecorder | null> }) {
  useMountEffect(() => { recorder.current?.interruptCapture(); });
  return null;
}

export default function VoiceNoteComposer({ onAttach, onClose, canStart = true, canAttach = true, captureRestricted = false, unavailableReason }: {
  onAttach: (file: File, durationMs: number) => boolean | void;
  onClose: () => void;
  canStart?: boolean;
  canAttach?: boolean;
  captureRestricted?: boolean;
  unavailableReason?: string;
}) {
  const [state, setState] = useState<VoiceNoteState>({ phase: 'idle', durationMs: 0 });
  const recorder = useRef<VoiceNoteRecorder | null>(null);
  const [attachError, setAttachError] = useState('');
  const requesting = state.phase === 'requesting';
  const recording = state.phase === 'recording';
  const stopping = state.phase === 'stopping';
  useMountEffect(() => {
    const instance = new VoiceNoteRecorder(setState);
    recorder.current = instance;
    return () => { recorder.current = null; instance.dispose(); };
  });
  function close() { recorder.current?.cancel(); onClose(); }
  return <div className="mb-2 rounded-xl border bg-background p-3" aria-label="Record a voice note">
    {captureRestricted && <InterruptRestrictedCapture recorder={recorder} />}
    <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-xs font-medium"><Mic size={14} />Voice note</span><Button type="button" variant="ghost" size="icon-sm" aria-label="Close voice recorder" onClick={close}><X size={14} /></Button></div>
    <p className="mt-1 text-xs text-muted-foreground">Record up to 2 minutes, listen, then attach. Nothing is sent until you send your message. Call mute and push-to-talk do not affect this recording.</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {(state.phase === 'idle' || state.phase === 'error') && <Button type="button" size="sm" disabled={!canStart || captureRestricted} onClick={() => { if (!canStart || captureRestricted) return; setAttachError(''); void recorder.current?.start(); }}><Mic size={14} />Start recording</Button>}
      {requesting && <><span role="status" className="text-xs">Waiting for microphone access…</span><Button type="button" size="sm" variant="outline" onClick={close}>Cancel</Button></>}
      {(recording || stopping) && <><span className="flex items-center gap-2 text-sm tabular-nums" aria-live="off"><span aria-hidden className="size-2 rounded-full bg-destructive" />{voiceNoteTime(state.durationMs)} / 2:00</span><Button type="button" size="sm" disabled={stopping} onClick={() => recorder.current?.stop()}><Square size={13} />{stopping ? 'Finishing…' : 'Stop recording'}</Button><Button type="button" size="sm" variant="ghost" aria-label="Discard recording" onClick={close}><Trash2 size={14} />Discard</Button></>}
      {state.phase === 'review' && state.file && <><VoiceNoteReview key={state.file.name} file={state.file} durationMs={state.durationMs} /><div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={!canAttach || captureRestricted} onClick={() => { if (!canAttach || captureRestricted) return; try { if (onAttach(state.file!, state.durationMs) !== false) close(); } catch (error) { setAttachError(errorMessage(error)); } }}>Attach voice note</Button><Button type="button" size="sm" variant="outline" disabled={!canStart || captureRestricted} onClick={() => { if (!canStart || captureRestricted) return; setAttachError(''); void recorder.current?.start(); }}>Record again</Button><Button type="button" size="sm" variant="ghost" onClick={close}>Discard</Button></div></>}
    </div>
    {captureRestricted && <p role="status" className="mt-2 text-xs text-muted-foreground">Posting permission changed, so recording has stopped. Completed audio stays on this device for review or discard; you cannot attach it while posting is restricted.</p>}
    {!canAttach && !captureRestricted && unavailableReason && <p role="status" className="mt-2 text-xs text-muted-foreground">{unavailableReason}</p>}
    {state.notice && <p role="status" className="mt-2 text-xs text-muted-foreground">{state.notice}</p>}
    {(state.error || attachError) && <p role="alert" className="mt-2 text-xs text-destructive">{state.error || attachError}</p>}
    {state.error && readDesktopBootReport()?.platform === 'windows' && /denied|privacy/i.test(state.error) && <Button type="button" variant="link" size="sm" onClick={() => void openDesktopPrivacySettings('microphone').catch((error) => setAttachError(errorMessage(error)))}>Open Windows microphone settings</Button>}
  </div>;
}
