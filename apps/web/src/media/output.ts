import { createOutputGain } from './volumeSettings';

/** Route only playback. Capture and recorded source tracks never pass through here. */
export async function applyOutputDevice(
  target: HTMLMediaElement | AudioContext,
): Promise<void> {
  const deviceId = localStorage.getItem('bc-output') ?? '';
  const sink = target as unknown as {
    setSinkId?: (id: string) => Promise<void>;
  };
  if (!sink.setSinkId) {
    if (deviceId && deviceId !== 'default')
      throw new Error(
        'Output selection is unavailable in this browser. Choose System default or change your system sound output.',
      );
    return;
  }
  try {
    await sink.setSinkId(deviceId);
  } catch (error) {
    throw new Error(
      'Could not use the selected output device. Reconnect it or choose another output in Settings.',
      { cause: error },
    );
  }
}

const elementOutputs = new WeakMap<HTMLMediaElement, { references: number; dispose(): void }>();

/** Share one source per element, including React's immediate detach/reattach checks. */
export function followElementOutput(element: HTMLMediaElement, onError: (error: Error) => void): () => void {
  const existing = elementOutputs.get(element);
  if (existing) {
    existing.references += 1;
    return releaseElementOutput(element, existing);
  }
  const context = new AudioContext({ latencyHint: 'interactive' });
  const source = context.createMediaElementSource(element);
  const master = createOutputGain(context);
  source.connect(master.gain).connect(context.destination);
  const stopOutput = followOutputDevice(context, onError);
  let disposed = false;
  const resume = () => {
    if (!disposed) void context.resume().catch(error => {
      if (!disposed) onError(error instanceof Error ? error : new Error(String(error)));
    });
  };
  element.addEventListener('play', resume);
  window.addEventListener('pointerdown', resume);
  resume();
  const entry = { references: 1, dispose: () => {
    if (disposed) return;
    disposed = true;
    element.removeEventListener('play', resume);
    window.removeEventListener('pointerdown', resume);
    stopOutput(); source.disconnect(); master.dispose();
    void context.close().catch(() => undefined);
  } };
  elementOutputs.set(element, entry);
  return releaseElementOutput(element, entry);
}

function releaseElementOutput(element: HTMLMediaElement, entry: { references: number; dispose(): void }): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.references -= 1;
    queueMicrotask(() => {
      if (entry.references === 0 && elementOutputs.get(element) === entry) {
        elementOutputs.delete(element);
        entry.dispose();
      }
    });
  };
}
export function followOutputDevice(
  target: HTMLMediaElement | AudioContext,
  onError: (error: Error) => void,
): () => void {
  let active = true;
  let queue = Promise.resolve();
  const update = () => {
    queue = queue.then(async () => {
      if (!active) return;
      try {
        await applyOutputDevice(target);
      } catch (error) {
        if (active)
          onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  update();
  window.addEventListener('bc-output', update);
  navigator.mediaDevices?.addEventListener('devicechange', update);
  return () => {
    active = false;
    window.removeEventListener('bc-output', update);
    navigator.mediaDevices?.removeEventListener('devicechange', update);
  };
}
