export type Point = { x: number; y: number };
export type ImageRect = Point & { width: number; height: number };
export type ImageMark =
  | { kind: 'draw'; points: Point[]; color: string; width: number }
  | { kind: 'arrow'; from: Point; to: Point; color: string; width: number }
  | { kind: 'redact'; rect: ImageRect };
export type ImageEdit = {
  sourceWidth: number;
  sourceHeight: number;
  turns: number;
  crop: ImageRect;
  marks: ImageMark[];
};

export const imageEditorLimits = {
  bytes: 25 * 1024 * 1024,
  pixels: 12_000_000,
  edge: 8192,
  history: 50,
  strokePoints: 2000,
  marks: 100,
};

export function checkImageDimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error(
      'This image has invalid dimensions. Your original file is unchanged.',
    );
  if (
    width > imageEditorLimits.edge ||
    height > imageEditorLimits.edge ||
    width * height > imageEditorLimits.pixels
  )
    throw new Error(
      'Image editing supports up to 12 megapixels and 8,192 pixels per side. Resize a copy first; your original file is unchanged.',
    );
}

export function initialImageEdit(width: number, height: number): ImageEdit {
  checkImageDimensions(width, height);
  return {
    sourceWidth: width,
    sourceHeight: height,
    turns: 0,
    crop: { x: 0, y: 0, width, height },
    marks: [],
  };
}

/** Canvas coordinates are independent of CSS fit and device pixel density. */
export function imagePoint(
  client: Point,
  bounds: { left: number; top: number; width: number; height: number },
  crop: ImageRect,
): Point {
  return {
    x:
      crop.x +
      Math.min(
        1,
        Math.max(0, (client.x - bounds.left) / Math.max(1, bounds.width)),
      ) *
        crop.width,
    y:
      crop.y +
      Math.min(
        1,
        Math.max(0, (client.y - bounds.top) / Math.max(1, bounds.height)),
      ) *
        crop.height,
  };
}

export function rectFromPoints(from: Point, to: Point): ImageRect {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/** Numeric/pointer selections are relative to the visible crop and cannot reveal discarded pixels. */
export function selectionRect(edit: ImageEdit, rect: ImageRect): ImageRect {
  const x = Math.max(
    0,
    Math.min(
      edit.crop.width - 1,
      Math.round(Number.isFinite(rect.x) ? rect.x : 0),
    ),
  );
  const y = Math.max(
    0,
    Math.min(
      edit.crop.height - 1,
      Math.round(Number.isFinite(rect.y) ? rect.y : 0),
    ),
  );
  return {
    x: edit.crop.x + x,
    y: edit.crop.y + y,
    width: Math.max(
      1,
      Math.min(
        edit.crop.width - x,
        Math.round(Number.isFinite(rect.width) ? rect.width : 1),
      ),
    ),
    height: Math.max(
      1,
      Math.min(
        edit.crop.height - y,
        Math.round(Number.isFinite(rect.height) ? rect.height : 1),
      ),
    ),
  };
}

export function rotateImageEdit(edit: ImageEdit): ImageEdit {
  const height = edit.turns % 2 ? edit.sourceWidth : edit.sourceHeight;
  const point = ({ x, y }: Point): Point => ({ x: height - y, y: x });
  const rect = (value: ImageRect): ImageRect => ({
    x: height - value.y - value.height,
    y: value.x,
    width: value.height,
    height: value.width,
  });
  return {
    ...edit,
    turns: (edit.turns + 1) % 4,
    crop: rect(edit.crop),
    marks: edit.marks.map((mark): ImageMark => {
      switch (mark.kind) {
        case 'draw':
          return { ...mark, points: mark.points.map(point) };
        case 'arrow':
          return { ...mark, from: point(mark.from), to: point(mark.to) };
        case 'redact':
          return { ...mark, rect: rect(mark.rect) };
      }
    }),
  };
}

export function editedImageName(name: string) {
  return `${
    name
      .replace(/\.[^.]*$/, '')
      .replace(/-edited$/, '')
      .slice(0, 160) || 'image'
  }-edited.png`;
}
