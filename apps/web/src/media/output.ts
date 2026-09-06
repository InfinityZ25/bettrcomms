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
