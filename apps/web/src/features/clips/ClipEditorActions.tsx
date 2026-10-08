import { Download, Play, Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';

type ClipOperation = 'preview' | 'export' | 'publish';

export function ClipEditorActions({
  busy,
  hasFile,
  canPublish,
  onCancel,
  onDownload,
  onRun,
}: {
  busy: boolean;
  hasFile: boolean;
  canPublish: boolean;
  onCancel: () => void;
  onDownload: () => void;
  onRun: (operation: ClipOperation) => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {busy ? (
        <Button variant="secondary" onClick={onCancel}>
          <Square size={14} /> Cancel
        </Button>
      ) : (
        <>
          <Button variant="secondary" onClick={() => void onRun('preview')}>
            <Play size={15} /> Preview
          </Button>
          {hasFile ? (
            <Button variant="secondary" onClick={onDownload}>
              <Download size={15} /> Download
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void onRun('export')}>
              <Download size={15} /> Prepare download
            </Button>
          )}
          <Button disabled={!canPublish} onClick={() => void onRun('publish')}>
            <Send size={15} /> Publish clip
          </Button>
        </>
      )}
    </div>
  );
}
