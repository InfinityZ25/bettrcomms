import {
  checkImageDimensions,
  editedImageName,
  imageEditorLimits,
  type ImageEdit,
  type ImageMark,
} from './imageEditorModel';

const ascii = (bytes: Uint8Array, offset: number, count: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + count));
const jpegFrameMarkers = new Set([
  192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
]);

/** Inspect dimensions/animation before asking a decoder to allocate a full image. */
export function inspectEditableImage(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    ascii(bytes, 1, 3) === 'PNG' &&
    ascii(bytes, 12, 4) === 'IHDR'
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (ascii(bytes, offset + 4, 4) === 'acTL')
        throw new Error(
          'Animated images are not edited here. Send the original animation or choose a static PNG, JPEG or WebP.',
        );
      if (length > bytes.length - offset - 12)
        throw new Error(
          'This PNG is incomplete. Your original file is unchanged.',
        );
      offset += length + 12;
    }
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (jpegFrameMarkers.has(marker) && length >= 7) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    bytes.length >= 30 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 4) === 'WEBP'
  ) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = ascii(bytes, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const data = offset + 8;
      if (length > bytes.length - data)
        throw new Error(
          'This WebP is incomplete. Your original file is unchanged.',
        );
      if (
        kind === 'ANIM' ||
        kind === 'ANMF' ||
        (kind === 'VP8X' && bytes[data] & 2)
      )
        throw new Error(
          'Animated images are not edited here. Send the original animation or choose a static PNG, JPEG or WebP.',
        );
      if (kind === 'VP8X' && length >= 10) {
        width =
          1 +
          bytes[data + 4] +
          (bytes[data + 5] << 8) +
          (bytes[data + 6] << 16);
        height =
          1 +
          bytes[data + 7] +
          (bytes[data + 8] << 8) +
          (bytes[data + 9] << 16);
      } else if (kind === 'VP8 ' && length >= 10 && !width) {
        width = view.getUint16(data + 6, true) & 0x3fff;
        height = view.getUint16(data + 8, true) & 0x3fff;
      } else if (kind === 'VP8L' && length >= 5 && !width) {
        width = 1 + bytes[data + 1] + ((bytes[data + 2] & 63) << 8);
        height =
          1 +
          (bytes[data + 2] >> 6) +
          (bytes[data + 3] << 2) +
          ((bytes[data + 4] & 15) << 10);
      }
      offset = data + length + (length % 2);
    }
  } else
    throw new Error(
      'Edit a static PNG, JPEG or WebP. SVG, GIF, AVIF and other formats can still be sent as their original files.',
    );
  checkImageDimensions(width, height);
  return { width, height };
}

export type EditableImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
};

export async function decodeEditableImage(
  file: File,
  signal: AbortSignal,
): Promise<EditableImage> {
  if (file.size > imageEditorLimits.bytes)
    throw new Error(
      'Image editing supports files up to 25 MB. Your original can still be sent unchanged.',
    );
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  inspectEditableImage(new Uint8Array(await file.arrayBuffer()));
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    });
    try {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      checkImageDimensions(bitmap.width, bitmap.height);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch (error) {
      bitmap.close();
      throw error;
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        image.src = '';
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      image.onload = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      image.onerror = () => {
        signal.removeEventListener('abort', abort);
        reject(
          new Error(
            'This image could not be decoded. Your original file is unchanged.',
          ),
        );
      };
      image.src = url;
    });
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    checkImageDimensions(image.naturalWidth, image.naturalHeight);
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => {
        image.src = '';
      },
    };
  } finally {
    URL.revokeObjectURL(url);
    image.onload = null;
    image.onerror = null;
  }
}

function paintMark(context: CanvasRenderingContext2D, mark: ImageMark) {
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  if (mark.kind === 'redact') {
    context.fillStyle = '#000000';
    // Cover every touched pixel; antialiased edges must not expose a sliver of text.
    const left = Math.floor(mark.rect.x);
    const top = Math.floor(mark.rect.y);
    context.fillRect(
      left,
      top,
      Math.ceil(mark.rect.x + mark.rect.width) - left,
      Math.ceil(mark.rect.y + mark.rect.height) - top,
    );
    return;
  }
  context.strokeStyle = mark.color;
  context.fillStyle = mark.color;
  context.lineWidth = mark.width;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  if (mark.kind === 'draw') {
    if (!mark.points.length) return;
    context.moveTo(mark.points[0].x, mark.points[0].y);
    for (const point of mark.points) context.lineTo(point.x, point.y);
    if (mark.points.length === 1)
      context.lineTo(mark.points[0].x + 0.01, mark.points[0].y);
    context.stroke();
    return;
  }
  context.moveTo(mark.from.x, mark.from.y);
  context.lineTo(mark.to.x, mark.to.y);
  context.stroke();
  const angle = Math.atan2(mark.to.y - mark.from.y, mark.to.x - mark.from.x);
  const head = Math.max(mark.width * 3, 8);
  context.beginPath();
  context.moveTo(mark.to.x, mark.to.y);
  context.lineTo(
    mark.to.x - Math.cos(angle - Math.PI / 6) * head,
    mark.to.y - Math.sin(angle - Math.PI / 6) * head,
  );
  context.lineTo(
    mark.to.x - Math.cos(angle + Math.PI / 6) * head,
    mark.to.y - Math.sin(angle + Math.PI / 6) * head,
  );
  context.closePath();
  context.fill();
}

/** Fresh raster only: this never encodes source bytes, EXIF or edit instructions. */
export function paintEditedImage(
  canvas: HTMLCanvasElement,
  image: EditableImage,
  edit: ImageEdit,
  preview = false,
) {
  const scale = preview
    ? Math.min(1, 1600 / edit.crop.width, 1200 / edit.crop.height)
    : 1;
  canvas.width = Math.max(1, Math.round(edit.crop.width * scale));
  canvas.height = Math.max(1, Math.round(edit.crop.height * scale));
  const context = canvas.getContext('2d');
  if (!context)
    throw new Error('Canvas is unavailable. Your original file is unchanged.');
  context.scale(
    canvas.width / edit.crop.width,
    canvas.height / edit.crop.height,
  );
  context.translate(-edit.crop.x, -edit.crop.y);
  context.save();
  switch (edit.turns) {
    case 1:
      context.translate(image.height, 0);
      context.rotate(Math.PI / 2);
      break;
    case 2:
      context.translate(image.width, image.height);
      context.rotate(Math.PI);
      break;
    case 3:
      context.translate(0, image.width);
      context.rotate(-Math.PI / 2);
      break;
  }
  context.drawImage(image.source, 0, 0);
  context.restore();
  for (const mark of edit.marks)
    if (mark.kind !== 'redact') paintMark(context, mark);
  // Redactions stay opaque above every annotation, even after adding new marks.
  for (const mark of edit.marks)
    if (mark.kind === 'redact') paintMark(context, mark);
}

export async function exportEditedImage(
  image: EditableImage,
  edit: ImageEdit,
  originalName: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<File> {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const canvas = document.createElement('canvas');
  try {
    paintEditedImage(canvas, image, edit);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) =>
          result
            ? resolve(result)
            : reject(
                new Error(
                  'The image could not be exported. Your original file is unchanged.',
                ),
              ),
        'image/png',
      ),
    );
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (blob.size > maxBytes)
      throw new Error(
        'The edited PNG exceeds this conversation’s file limit. Crop a smaller area or cancel to keep the original.',
      );
    return new File([blob], editedImageName(originalName), {
      type: 'image/png',
      lastModified: Date.now(),
    });
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}
