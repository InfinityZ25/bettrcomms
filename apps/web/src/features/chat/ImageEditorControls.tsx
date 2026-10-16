import {
  ArrowUpRight,
  Crop,
  PenLine,
  Redo2,
  RotateCw,
  Square,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ImageEditorController } from './useImageEditor';

const tools = [
  ['crop', 'Crop', Crop],
  ['draw', 'Draw', PenLine],
  ['arrow', 'Arrow', ArrowUpRight],
  ['redact', 'Redact', Square],
] as const;
const buttonClass =
  'min-h-11 min-w-11 rounded-xl aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/20';

export function ImageEditorToolbar({
  editor,
}: {
  editor: ImageEditorController;
}) {
  const { tool, exporting } = editor;
  return (
    <div
      className="flex flex-wrap gap-1"
      role="toolbar"
      aria-label="Image editing tools"
    >
      {tools.map(([value, title, Icon]) => (
        <Button
          key={value}
          type="button"
          variant={tool === value ? 'secondary' : 'ghost'}
          className={buttonClass}
          aria-pressed={tool === value}
          disabled={exporting}
          onClick={() => editor.selectTool(value)}
        >
          <Icon data-icon="inline-start" />
          {title}
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        className={buttonClass}
        disabled={exporting}
        aria-label="Rotate clockwise"
        onClick={editor.rotate}
      >
        <RotateCw />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={buttonClass}
        aria-label="Undo"
        disabled={!editor.canUndo || exporting}
        onClick={editor.undo}
      >
        <Undo2 />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={buttonClass}
        aria-label="Redo"
        disabled={!editor.canRedo || exporting}
        onClick={editor.redo}
      >
        <Redo2 />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={buttonClass}
        disabled={exporting}
        onClick={editor.reset}
      >
        Reset image
      </Button>
    </div>
  );
}

export function ImageEditorSelection({
  editor,
}: {
  editor: ImageEditorController;
}) {
  const { tool, edit, exporting, selection, color, lineWidth } = editor;
  if (!edit) return null;
  return (
    <>
      {tool !== 'draw' && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ['x', 'Left'],
                ['y', 'Top'],
                ['width', 'Width'],
                ['height', 'Height'],
              ] as const
            ).map(([key, title]) => (
              <label key={key} className="flex flex-col gap-1 text-xs">
                {title}
                <Input
                  type="number"
                  min={key === 'x' || key === 'y' ? 0 : 1}
                  max={
                    key === 'x' || key === 'width'
                      ? edit.crop.width
                      : edit.crop.height
                  }
                  step={1}
                  value={selection[key]}
                  disabled={exporting}
                  className="min-h-11 rounded-xl tabular-nums"
                  onChange={(event) =>
                    editor.setSelection({
                      ...selection,
                      [key]: Number(event.target.value),
                    })
                  }
                />
              </label>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            className={buttonClass}
            disabled={exporting}
            onClick={editor.applySelection}
          >
            {tool === 'crop'
              ? 'Apply crop'
              : tool === 'redact'
                ? 'Add redaction'
                : 'Add arrow'}
          </Button>
        </div>
      )}
      {(tool === 'draw' || tool === 'arrow') && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs">
            Drawing color
            <input
              type="color"
              aria-label="Drawing color"
              value={color}
              disabled={exporting}
              className="h-11 w-12 cursor-pointer rounded-xl border bg-background p-1"
              onChange={(event) => editor.setColor(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            Line width
            <Input
              type="number"
              min={1}
              max={100}
              value={lineWidth}
              disabled={exporting}
              className="min-h-11 w-20 rounded-xl"
              onChange={(event) =>
                editor.setLineWidth(
                  Math.max(1, Math.min(100, Number(event.target.value) || 1)),
                )
              }
            />
          </label>
        </div>
      )}
    </>
  );
}
