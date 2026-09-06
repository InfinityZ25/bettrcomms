const bounded = (value: number) => Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 1;

function processing(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem('bc-processing') ?? '{}') ?? {}; }
  catch { return {}; }
}

/** Replaces the old dB gain; never applies a second independent input gain. */
export function readInputVolume(): number {
  const current = processing();
  return typeof current.inputVolume === 'number'
    ? bounded(current.inputVolume)
    : bounded(10 ** ((typeof current.gainDb === 'number' ? current.gainDb : 0) / 20));
}

export function setInputVolume(value: number): void {
  localStorage.setItem('bc-processing', JSON.stringify({ ...processing(), gainDb: 0, inputVolume: bounded(value) }));
  window.dispatchEvent(new Event('bc-input-volume'));
}

export function readOutputVolume(): number {
  const stored = localStorage.getItem('bc-output-volume');
  return stored === null ? 1 : bounded(Number(stored));
}

export function setOutputVolume(value: number): void {
  localStorage.setItem('bc-output-volume', String(bounded(value)));
  window.dispatchEvent(new Event('bc-output-volume'));
}

/** Connect playback to this node, then connect it to the existing output/limiter. */
export function createOutputGain(context: AudioContext): { gain: GainNode; dispose(): void } {
  const gain = context.createGain();
  gain.gain.value = readOutputVolume();
  const update = () => gain.gain.setTargetAtTime(readOutputVolume(), context.currentTime, 0.02);
  const dispose = () => {
    window.removeEventListener('bc-output-volume', update);
    context.removeEventListener('statechange', closed);
    gain.disconnect();
  };
  const closed = () => { if (context.state === 'closed') dispose(); };
  window.addEventListener('bc-output-volume', update);
  context.addEventListener('statechange', closed);
  return { gain, dispose };
}
