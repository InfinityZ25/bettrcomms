export function audioFileDuration(
  file: File,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'));
      return;
    }
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    let settled = false;
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            'Could not read this audio. Choose a supported sound file.',
          ),
        ),
      15000,
    );
    function finish(error?: Error, value?: number) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(value!);
    }
    function abort() {
      finish(new DOMException('Cancelled', 'AbortError'));
    }
    signal.addEventListener('abort', abort, { once: true });
    audio.onloadedmetadata = () => {
      if (
        !Number.isFinite(audio.duration) ||
        audio.duration <= 0 ||
        audio.duration > 30
      )
        finish(new Error('Sounds must be 30 seconds or shorter.'));
      else finish(undefined, Math.max(1, Math.round(audio.duration * 1000)));
    };
    audio.onerror = () =>
      finish(new Error('Could not read this audio format.'));
    audio.preload = 'metadata';
    audio.src = url;
  });
}
