import { describe, expect, it } from 'vitest';
import {
  checkImageDimensions,
  editedImageName,
  imagePoint,
  initialImageEdit,
  rotateImageEdit,
  selectionRect,
  type ImageEdit,
} from './imageEditorModel';

describe('image edit geometry', () => {
  it('keeps crop and annotations together through four rotations', () => {
    const original: ImageEdit = {
      ...initialImageEdit(100, 80),
      crop: { x: 10, y: 20, width: 50, height: 30 },
      marks: [
        { kind: 'redact', rect: { x: 15, y: 25, width: 12, height: 8 } },
        {
          kind: 'arrow',
          from: { x: 20, y: 30 },
          to: { x: 50, y: 45 },
          width: 4,
          color: '#ff0000',
        },
        {
          kind: 'draw',
          points: [
            { x: 35, y: 36 },
            { x: 38, y: 40 },
          ],
          width: 3,
          color: '#ffffff',
        },
      ],
    };
    const once = rotateImageEdit(original);
    expect(once.crop).toEqual({ x: 30, y: 10, width: 30, height: 50 });
    expect(once.marks[0]).toEqual({
      kind: 'redact',
      rect: { x: 47, y: 15, width: 8, height: 12 },
    });
    expect(rotateImageEdit(rotateImageEdit(rotateImageEdit(once)))).toEqual(
      original,
    );
    expect(original.crop).toEqual({ x: 10, y: 20, width: 50, height: 30 });
  });
  it('maps pointer input using visible CSS bounds rather than bitmap or DPR dimensions', () => {
    expect(
      imagePoint(
        { x: 135, y: 95 },
        { left: 10, top: 20, width: 250, height: 150 },
        { x: 40, y: 50, width: 1000, height: 600 },
      ),
    ).toEqual({ x: 540, y: 350 });
    expect(
      imagePoint(
        { x: -10, y: 400 },
        { left: 10, top: 20, width: 250, height: 150 },
        { x: 40, y: 50, width: 1000, height: 600 },
      ),
    ).toEqual({ x: 40, y: 650 });
  });
  it('bounds keyboard crop input within the current crop and rounds whole output pixels', () => {
    const edit = {
      ...initialImageEdit(100, 80),
      crop: { x: 10, y: 20, width: 50, height: 30 },
    };
    expect(
      selectionRect(edit, { x: 45, y: 10, width: 400, height: 100 }),
    ).toEqual({ x: 55, y: 30, width: 5, height: 20 });
    expect(
      selectionRect(edit, {
        x: -4,
        y: Number.NaN,
        width: 0,
        height: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ x: 10, y: 20, width: 1, height: 1 });
  });
  it.each([
    [0, 10],
    [100, -1],
    [9000, 10],
    [6000, 6000],
    [Number.NaN, 10],
  ])('rejects unsafe decode/canvas dimensions %s×%s', (width, height) => {
    expect(() => checkImageDimensions(width, height)).toThrow();
  });
  it('keeps sensible PNG filenames after repeated edits', () => {
    expect(editedImageName('holiday.jpeg')).toBe('holiday-edited.png');
    expect(editedImageName('holiday-edited.png')).toBe('holiday-edited.png');
    expect(editedImageName('.png')).toBe('image-edited.png');
  });
});
