import { useCallback, useRef, useState, type PointerEvent } from 'react';
import { useMountEffect } from '@/hooks/useMountEffect';
import {
  decodeEditableImage,
  exportEditedImage,
  paintEditedImage,
  type EditableImage,
} from './imageEditorFiles';
import {
  imageEditorLimits,
  imagePoint,
  initialImageEdit,
  rectFromPoints,
  rotateImageEdit,
  selectionRect,
  type ImageEdit,
  type ImageMark,
  type ImageRect,
  type Point,
} from './imageEditorModel';

export type ImageEditorTool = 'crop' | 'draw' | 'arrow' | 'redact';
type Gesture = {
  pointer: number;
  tool: ImageEditorTool;
  start: Point;
  points: Point[];
};
const fullSelection = (edit: ImageEdit): ImageRect => ({
  x: 0,
  y: 0,
  width: edit.crop.width,
  height: edit.crop.height,
});
export type ImageEditorProps = {
  file: File;
  maxBytes: number;
  onClose: () => void;
  onApply: (file: File) => boolean;
};

export function useImageEditor({
  file,
  maxBytes,
  onClose,
  onApply,
}: ImageEditorProps) {
  const [image, setImage] = useState<EditableImage>();
  const [history, setHistory] = useState<{ items: ImageEdit[]; index: number }>(
    { items: [], index: 0 },
  );
  const [tool, setTool] = useState<ImageEditorTool>('crop');
  const [selection, setSelection] = useState<ImageRect>({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  const [color, setColor] = useState('#ef4444');
  const [lineWidth, setLineWidth] = useState(4);
  const [liveMark, setLiveMark] = useState<ImageMark>();
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const closed = useRef(false);
  const saving = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const edit = history.items[history.index];

  useMountEffect(() => {
    const current = new AbortController();
    controller.current = current;
    closed.current = false;
    let decoded: EditableImage | undefined;
    void decodeEditableImage(file, current.signal)
      .then((result) => {
        decoded = result;
        if (current.signal.aborted) {
          result.close();
          return;
        }
        const initial = initialImageEdit(result.width, result.height);
        setImage(result);
        setHistory({ items: [initial], index: 0 });
        setSelection(fullSelection(initial));
      })
      .catch((failure: unknown) => {
        if (!current.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'This image could not be opened. Your original file is unchanged.',
          );
      });
    return () => {
      closed.current = true;
      current.abort();
      decoded?.close();
      gesture.current = null;
      if (canvas.current) {
        canvas.current.width = 1;
        canvas.current.height = 1;
      }
    };
  });

  const setCanvas = useCallback(
    (element: HTMLCanvasElement | null) => {
      canvas.current = element;
      if (!element || !image || !edit) return;
      const shown = liveMark
        ? { ...edit, marks: [...edit.marks, liveMark] }
        : edit;
      try {
        paintEditedImage(element, image, shown, true);
        if (tool === 'crop') {
          const context = element.getContext('2d');
          if (!context) return;
          const rect = selectionRect(edit, selection);
          context.resetTransform();
          const sx = element.width / edit.crop.width;
          const sy = element.height / edit.crop.height;
          context.strokeStyle = '#ffffff';
          context.lineWidth = 2;
          context.setLineDash([6, 4]);
          context.strokeRect(
            (rect.x - edit.crop.x) * sx + 1,
            (rect.y - edit.crop.y) * sy + 1,
            Math.max(0, rect.width * sx - 2),
            Math.max(0, rect.height * sy - 2),
          );
        }
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : 'The image preview is unavailable. Your original file is unchanged.',
        );
      }
    },
    [edit, image, liveMark, selection, tool],
  );

  const close = () => {
    closed.current = true;
    controller.current?.abort();
    onClose();
  };
  const commit = (next: ImageEdit) => {
    if (saving.current) return;
    gesture.current = null;
    setHistory((current) => {
      const items = [...current.items.slice(0, current.index + 1), next].slice(
        -imageEditorLimits.history,
      );
      return { items, index: items.length - 1 };
    });
    setSelection(fullSelection(next));
    setLiveMark(undefined);
    setError('');
  };
  const moveHistory = (delta: number) => {
    gesture.current = null;
    const index = Math.max(
      0,
      Math.min(history.items.length - 1, history.index + delta),
    );
    setHistory({ ...history, index });
    setSelection(fullSelection(history.items[index]));
    setLiveMark(undefined);
  };
  const appendMark = (mark: ImageMark) => {
    if (!edit) return;
    if (edit.marks.length >= imageEditorLimits.marks) {
      setError(
        'This image has 100 annotations. Undo one or reset before adding more.',
      );
      return;
    }
    commit({ ...edit, marks: [...edit.marks, mark] });
  };
  const applySelection = () => {
    if (!edit || saving.current) return;
    const rect = selectionRect(edit, selection);
    switch (tool) {
      case 'crop':
        commit({ ...edit, crop: rect });
        break;
      case 'redact':
        appendMark({ kind: 'redact', rect });
        break;
      case 'arrow':
        appendMark({
          kind: 'arrow',
          from: { x: rect.x, y: rect.y },
          to: { x: rect.x + rect.width, y: rect.y + rect.height },
          color,
          width: lineWidth,
        });
        break;
      case 'draw':
        break;
    }
  };
  const pointerPoint = (event: PointerEvent<HTMLCanvasElement>) =>
    imagePoint(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      edit!.crop,
    );
  const gestureMark = (current: Gesture, end: Point): ImageMark | undefined => {
    switch (current.tool) {
      case 'draw':
        return {
          kind: 'draw',
          points: current.points,
          color,
          width: lineWidth,
        };
      case 'arrow':
        return {
          kind: 'arrow',
          from: current.start,
          to: end,
          color,
          width: lineWidth,
        };
      case 'redact':
        return { kind: 'redact', rect: rectFromPoints(current.start, end) };
      case 'crop':
        return undefined;
    }
  };
  const pointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId || !edit) return;
    const point = pointerPoint(event);
    if (current.tool === 'crop') {
      const selected = rectFromPoints(current.start, point);
      setSelection({
        ...selected,
        x: selected.x - edit.crop.x,
        y: selected.y - edit.crop.y,
      });
    } else {
      if (
        current.tool === 'draw' &&
        current.points.length < imageEditorLimits.strokePoints
      )
        current.points = [...current.points, point];
      setLiveMark(gestureMark(current, point));
    }
  };
  const save = async () => {
    const signal = controller.current?.signal;
    if (
      !image ||
      !edit ||
      !signal ||
      signal.aborted ||
      closed.current ||
      saving.current
    )
      return;
    if (gesture.current) {
      setError(
        'Finish the current drawing or crop gesture before using this image.',
      );
      return;
    }
    saving.current = true;
    setExporting(true);
    setError('');
    try {
      const result = await exportEditedImage(
        image,
        edit,
        file.name,
        maxBytes,
        signal,
      );
      if (!signal.aborted && !closed.current) {
        if (onApply(result)) close();
        else
          setError(
            'The attachment changed or sending is unavailable. Your original draft is unchanged.',
          );
      }
    } catch (failure) {
      if (!signal.aborted && !closed.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Export failed. Your original file is unchanged.',
        );
    } finally {
      saving.current = false;
      if (!signal.aborted && !closed.current) setExporting(false);
    }
  };

  const cancelGesture = () => {
    gesture.current = null;
    setLiveMark(undefined);
  };
  const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (
      exporting ||
      !edit ||
      !event.isPrimary ||
      event.button !== 0 ||
      gesture.current
    )
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointerPoint(event);
    gesture.current = {
      pointer: event.pointerId,
      tool,
      start: point,
      points: [point],
    };
    setLiveMark(gestureMark(gesture.current, point));
  };
  const pointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    pointerMove(event);
    const end = pointerPoint(event);
    const mark = gestureMark(current, end);
    cancelGesture();
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (
      mark &&
      (mark.kind === 'draw' ||
        Math.hypot(end.x - current.start.x, end.y - current.start.y) >= 1)
    )
      appendMark(mark);
  };

  return {
    image,
    edit,
    tool,
    selection,
    color,
    lineWidth,
    error,
    exporting,
    canUndo: history.index > 0,
    canRedo: history.index < history.items.length - 1,
    setCanvas,
    close,
    save,
    pointerDown,
    pointerMove,
    pointerUp,
    cancelGesture,
    undo: () => moveHistory(-1),
    redo: () => moveHistory(1),
    selectTool: (value: ImageEditorTool) => {
      cancelGesture();
      setTool(value);
    },
    rotate: () => {
      if (edit) commit(rotateImageEdit(edit));
    },
    reset: () => {
      if (image) commit(initialImageEdit(image.width, image.height));
    },
    setSelection,
    setColor,
    setLineWidth,
    applySelection,
  };
}

export type ImageEditorController = ReturnType<typeof useImageEditor>;
