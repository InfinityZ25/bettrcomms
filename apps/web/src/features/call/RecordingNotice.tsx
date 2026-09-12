import { useEffect } from 'react';
import { Check, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecordingDownload } from '@/features/recordings/RecordingDownload';
import { listRecordings } from '@/media/recordingLibrary';
import { useActiveCall } from './CallSessionContext';

/** Long enough to read and act on, short enough not to become furniture. */
const DISMISS_AFTER = 9000;

/**
 * Where a just-finished recording went.
 *
 * This was a block in the call and a second, larger block in the lobby, each
 * with a heading, a sentence, a button and a disclosure — and it stayed until
 * the next recording started, so it survived leaving the call and survived the
 * recording being deleted. One notice now, in a corner, which leaves on its
 * own when the recording is safely stored and stays when it is not.
 *
 * Mounted beside the app shell rather than inside the call screen: it outlives
 * the call it came from by design, since stopping a recording and leaving are
 * usually the same moment.
 */
export default function RecordingNotice({
  onRecordings,
}: {
  onRecordings: () => void;
}) {
  const { result, saveState, savedId, dismissResult } = useActiveCall();
  const saved = saveState === 'saved';

  // A stored recording needs no confirmation for long. A failed one is the
  // only copy there is, so it waits to be dealt with.
  useEffect(() => {
    if (!result || !saved) return;
    const timer = setTimeout(dismissResult, DISMISS_AFTER);
    return () => clearTimeout(timer);
  }, [result, saved]);

  // Deleting the recording takes the notice with it. Offering to open
  // something that is gone is worse than saying nothing.
  useEffect(() => {
    if (!savedId) return;
    const check = () => {
      void listRecordings()
        .then((items) => {
          if (!items.some((item) => item.id === savedId)) dismissResult();
        })
        .catch(() => {});
    };
    window.addEventListener('bc-recordings-changed', check);
    return () => window.removeEventListener('bc-recordings-changed', check);
  }, [savedId]);

  if (!result) return null;
  const failed = saveState === 'failed';

  return (
    <div
      role="status"
      className="fixed top-3 right-3 z-40 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-border bg-card/95 p-3 shadow-[0_16px_40px_rgb(0_0_0/0.28)] backdrop-blur [.desktop-frame_&]:top-[52px]"
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className={
            'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full ' +
            (failed
              ? 'bg-destructive/15 text-destructive'
              : 'bg-primary/15 text-primary')
          }
        >
          {failed ? <TriangleAlert size={14} /> : <Check size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-[0.8rem] font-semibold">
            {failed
              ? 'Recording not saved'
              : saved
                ? 'Recording saved'
                : 'Saving recording…'}
          </strong>
          <p className="mt-0.5 text-[0.7rem] leading-5 text-muted-foreground">
            {failed
              ? 'This is the only copy. Download the tracks before you close the app.'
              : 'On this device, with a mixer for every voice.'}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss"
          className="-mt-1 -mr-1 size-7 shrink-0 text-muted-foreground"
          onClick={dismissResult}
        >
          <X size={15} />
        </Button>
      </div>
      {saved && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2.5 w-full"
          onClick={onRecordings}
        >
          Open it
        </Button>
      )}
      {failed && (
        <div className="mt-1.5 max-h-56 overflow-auto">
          {result.files.map((file) => (
            <RecordingDownload key={file.name} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}
