import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RecordingDownload } from '@/features/recordings/RecordingDownload';
import type { RecordingResult } from '@/media';

/** Where a just-finished recording went, and how to get the raw tracks. */
export default function RecordingNotice({
  result,
  saveStatus,
  onRecordings,
  variant,
}: {
  result: RecordingResult;
  saveStatus: string;
  onRecordings: () => void;
  variant: 'lobby' | 'call';
}) {
  const files = result.files.map((file) => (
    <RecordingDownload key={file.name} file={file} />
  ));
  return (
    <div
      className={
        'recording-downloads' + (variant === 'call' ? ' call-recording-notice' : '')
      }
    >
      {variant === 'lobby' && (
        <strong>
          <Download size={16} /> Your recording
        </strong>
      )}
      <span>{saveStatus}</span>
      {variant === 'lobby' ? (
        <Button variant="secondary" onClick={onRecordings}>
          Open recordings &amp; player
        </Button>
      ) : (
        <button onClick={onRecordings}>Open recordings &amp; player</button>
      )}
      <details>
        <summary>Download original tracks</summary>
        {files}
      </details>
    </div>
  );
}
