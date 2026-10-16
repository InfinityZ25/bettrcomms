import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  ImageEditorSelection,
  ImageEditorToolbar,
} from './ImageEditorControls';
import { useImageEditor, type ImageEditorProps } from './useImageEditor';

const help = {
  crop: 'Drag a crop, or enter its position and size below.',
  redact:
    'Drag to cover information with solid black. Blocks are flattened above all drawings.',
  arrow: 'Drag an arrow, or enter its start and extent below.',
  draw: 'Draw with a mouse, pen or finger. Arrow has a keyboard-friendly coordinate alternative.',
};

export default function ImageEditor(props: ImageEditorProps) {
  const editor = useImageEditor(props);
  const { image, edit, exporting, error, tool } = editor;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) editor.close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-1rem)] max-w-[calc(100%-1rem)] gap-3 overflow-y-auto rounded-3xl p-3 sm:max-w-4xl sm:p-5"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' && event.target instanceof HTMLInputElement)
            event.preventDefault();
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === 'z' &&
            !(event.target instanceof HTMLInputElement)
          ) {
            event.preventDefault();
            if (edit && !exporting) {
              if (event.shiftKey) editor.redo();
              else editor.undo();
            }
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit image</DialogTitle>
          <DialogDescription>
            Changes stay on this device until you send.
          </DialogDescription>
        </DialogHeader>
        {image && edit && (
          <>
            <ImageEditorToolbar editor={editor} />
            <div className="flex min-h-32 items-center justify-center overflow-hidden rounded-2xl border border-border bg-background/70 p-2 shadow-inner">
              <canvas
                ref={editor.setCanvas}
                role="img"
                aria-label="Image editing canvas"
                className={cn(
                  'block max-h-[38dvh] max-w-full touch-none rounded-md shadow-[var(--shadow-soft)] outline outline-1 outline-foreground/10',
                  exporting ? 'cursor-wait' : 'cursor-crosshair',
                )}
                style={{ width: 'auto', height: 'auto' }}
                onPointerDown={editor.pointerDown}
                onPointerMove={editor.pointerMove}
                onPointerUp={editor.pointerUp}
                onPointerCancel={editor.cancelGesture}
                onLostPointerCapture={editor.cancelGesture}
              />
            </div>
            <p
              className="text-xs text-muted-foreground tabular-nums"
              role="status"
            >
              {edit.crop.width} × {edit.crop.height} px · {help[tool]}
            </p>
            <ImageEditorSelection editor={editor} />
          </>
        )}
        {!image && !error && (
          <p
            role="status"
            className="py-8 text-center text-sm text-muted-foreground"
          >
            Opening image…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="sticky bottom-0 gap-2 bg-popover pt-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11"
            onClick={editor.close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11 min-w-11"
            disabled={!image || !edit || exporting}
            onClick={() => void editor.save()}
          >
            {exporting ? 'Preparing PNG…' : 'Use edited image'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
