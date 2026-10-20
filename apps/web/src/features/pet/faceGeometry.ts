/**
 * Where a mouth and cheeks go on a face that was drawn without either.
 *
 * Blobatars are two capsule eyes on a body, and that stays their identity. The
 * companion borrows a mouth only for moments that need one — a yawn, an "o",
 * a grin while being thrown — and blush for being petted. Both are placed from
 * the eyes as the generator actually rendered them, measured once per
 * character in the drawing's own 100-unit viewBox, so they land on every
 * silhouette without knowing anything about how it was made.
 */
export type Box = { x: number; y: number; width: number; height: number };
export type FaceGeometry = {
  mouth: { x: number; y: number; width: number };
  cheeks: { x: number; y: number; rx: number; ry: number }[];
  /** Offset that puts the body's centre-bottom at the frame's centre-bottom. */
  feet: { dx: number; dy: number };
  /** The body's width, as a share of the frame, for the contact shadow. */
  span: number;
  body: Box;
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function faceGeometry(body: Box, eyes: readonly Box[]): FaceGeometry {
  const sorted = [...eyes].sort((left, right) => left.x - right.x);
  const left = sorted[0] ?? { x: body.x + body.width * 0.35, y: body.y + body.height * 0.4, width: 4, height: 10 };
  const right = sorted[sorted.length - 1] ?? left;
  const centre = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const l = centre(left);
  const r = centre(right);
  const gap = Math.max(6, r.x - l.x);
  const eyeBottom = Math.max(left.y + left.height, right.y + right.height);
  const eyeHeight = (left.height + right.height) / 2;
  // Big enough to read at 54px, which is the smallest a companion is drawn.
  const width = clamp(gap * 0.6, 7.5, 14);
  const mouthY = Math.min(eyeBottom + clamp(eyeHeight * 0.3, 2, 4.5), body.y + body.height * 0.82 - width * 0.55);
  const cheekY = Math.min(eyeBottom - eyeHeight * 0.05, body.y + body.height * 0.82);
  const reach = clamp(gap * 0.36, 4, 9);
  return {
    mouth: { x: (l.x + r.x) / 2, y: mouthY, width },
    cheeks: [
      { x: clamp(l.x - reach, body.x + 5, 96), y: cheekY, rx: clamp(gap * 0.26, 3.6, 7), ry: clamp(gap * 0.15, 2.2, 4) },
      { x: clamp(r.x + reach, 4, body.x + body.width - 5), y: cheekY, rx: clamp(gap * 0.26, 3.6, 7), ry: clamp(gap * 0.15, 2.2, 4) },
    ],
    feet: { dx: 50 - (body.x + body.width / 2), dy: 100 - (body.y + body.height) },
    span: clamp(body.width / 100, 0.3, 0.95),
    body,
  };
}

/** Path data for each mouth, centred on the measured point. */
export function mouthPaths(mouth: FaceGeometry['mouth']) {
  const { x, y, width: w } = mouth;
  const h = w / 2;
  const f = (value: number) => value.toFixed(2);
  return {
    smile: `M${f(x - h)} ${f(y)}Q${f(x)} ${f(y + w * 0.62)} ${f(x + h)} ${f(y)}`,
    open: `M${f(x - h)} ${f(y)}Q${f(x)} ${f(y + w * 1.15)} ${f(x + h)} ${f(y)}Z`,
    cat: `M${f(x - h)} ${f(y)}q${f(h / 2)} ${f(w * 0.42)} ${f(h)} 0q${f(h / 2)} ${f(w * 0.42)} ${f(h)} 0`,
    flat: `M${f(x - h * 0.8)} ${f(y + 1)}H${f(x + h * 0.8)}`,
    wavy: `M${f(x - h)} ${f(y + 1)}q${f(h / 4)} ${f(-w * 0.2)} ${f(h / 2)} 0t${f(h / 2)} 0t${f(h / 2)} 0t${f(h / 2)} 0`,
  };
}
