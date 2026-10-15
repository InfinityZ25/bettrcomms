import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeEditableImage,
  exportEditedImage,
  inspectEditableImage,
  paintEditedImage,
  type EditableImage,
} from './imageEditorFiles';
import { initialImageEdit } from './imageEditorModel';

function png(width = 100, height = 80, animated = false) {
  const bytes = new Uint8Array(animated ? 66 : 45);
  const view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  if (animated) {
    view.setUint32(33, 9);
    bytes.set([97, 99, 84, 76], 37);
  } else bytes.set([73, 69, 78, 68], 37);
  return bytes;
}
function canvasFixture() {
  const calls: { kind: string; values: unknown[] }[] = [];
  const context = new Proxy<Record<string, unknown>>(
    {},
    {
      get:
        (_target, key) =>
        (...values: unknown[]) =>
          calls.push({ kind: String(key), values }),
      set: (_target, key, value) => {
        calls.push({ kind: String(key), values: [value] });
        return true;
      },
    },
  );
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (done: (blob: Blob) => void, type: string) =>
      done(new Blob(['new raster'], { type })),
  };
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  const image: EditableImage = {
    source: {} as CanvasImageSource,
    width: 100,
    height: 80,
    close: vi.fn(),
  };
  return { canvas, calls, image };
}
afterEach(() => vi.unstubAllGlobals());

describe('safe editable raster files', () => {
  it('reads static PNG and JPEG dimensions without decoding', () => {
    expect(inspectEditableImage(png())).toEqual({ width: 100, height: 80 });
    expect(
      inspectEditableImage(
        new Uint8Array([
          255, 216, 255, 192, 0, 8, 8, 0, 40, 0, 60, 1, 255, 217,
        ]),
      ),
    ).toEqual({ width: 60, height: 40 });
  });
  it('rejects misleading SVG/GIF and animated PNG content', () => {
    expect(() =>
      inspectEditableImage(
        new TextEncoder().encode('<svg width="100" height="80"/>'),
      ),
    ).toThrow('static PNG');
    expect(() =>
      inspectEditableImage(new TextEncoder().encode('GIF89a')),
    ).toThrow('static PNG');
    expect(() => inspectEditableImage(png(100, 80, true))).toThrow('Animated');
  });
  it('rejects animated WebP even when dimensions look harmless', () => {
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode('RIFF'), 0);
    bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
    new DataView(bytes.buffer).setUint32(16, 10, true);
    bytes[20] = 2;
    expect(() => inspectEditableImage(bytes)).toThrow('Animated');
  });
  it('rejects image bombs before calling the browser decoder', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    await expect(
      decodeEditableImage(
        new File([png(7000, 7000)], 'bomb.png'),
        new AbortController().signal,
      ),
    ).rejects.toThrow('12 megapixels');
    expect(decode).not.toHaveBeenCalled();
  });
  it('closes a decoded bitmap when its dialog was cancelled while decoding', async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    const controller = new AbortController();
    const result = decodeEditableImage(
      new File([png()], 'image.png'),
      controller.signal,
    );
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const close = vi.fn();
    controller.abort();
    resolve({ width: 100, height: 80, close });
    await expect(result).rejects.toThrow('Cancelled');
    expect(close).toHaveBeenCalledOnce();
  });
  it('paints solid redaction after every colored annotation', () => {
    const { canvas, calls, image } = canvasFixture();
    const edit = initialImageEdit(100, 80);
    edit.marks = [
      { kind: 'redact', rect: { x: 10.2, y: 20.2, width: 10, height: 4 } },
      {
        kind: 'arrow',
        from: { x: 0, y: 0 },
        to: { x: 50, y: 40 },
        width: 2,
        color: '#ff0000',
      },
    ];
    paintEditedImage(canvas as unknown as HTMLCanvasElement, image, edit);
    expect(calls.at(-1)).toEqual({ kind: 'fillRect', values: [10, 20, 11, 5] });
    expect(calls.at(-2)).toEqual({ kind: 'fillStyle', values: ['#000000'] });
  });
  it('exports only a fresh PNG raster with cropped dimensions and clears the canvas', async () => {
    const { canvas, image } = canvasFixture();
    const edit = {
      ...initialImageEdit(100, 80),
      crop: { x: 20, y: 10, width: 50, height: 30 },
    };
    const result = await exportEditedImage(
      image,
      edit,
      'private-exif.jpg',
      1000,
      new AbortController().signal,
    );
    expect(result.type).toBe('image/png');
    expect(result.name).toBe('private-exif-edited.png');
    expect(await result.text()).toBe('new raster');
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });
  it('discards late exports after cancellation and preserves the original on size failures', async () => {
    const { canvas, image } = canvasFixture();
    const controller = new AbortController();
    let finish!: (blob: Blob) => void;
    canvas.toBlob = (done) => {
      finish = done;
    };
    const result = exportEditedImage(
      image,
      initialImageEdit(100, 80),
      'original.png',
      1000,
      controller.signal,
    );
    controller.abort();
    finish(new Blob(['new raster']));
    await expect(result).rejects.toThrow('Cancelled');
    expect(canvas.width).toBe(1);
    canvas.toBlob = (done) => done(new Blob(['too big']));
    await expect(
      exportEditedImage(
        image,
        initialImageEdit(100, 80),
        'original.png',
        1,
        new AbortController().signal,
      ),
    ).rejects.toThrow('exceeds');
  });
});
