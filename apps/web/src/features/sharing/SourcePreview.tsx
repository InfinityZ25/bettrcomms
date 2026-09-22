import { useEffect, useRef, useState } from 'react';
import { invokeNativeCapture as invoke } from '@/desktop/capture';
import { Monitor, PanelsTopLeft } from 'lucide-react';
import { errorMessage } from '@/lib/errors';
import type { NativeScreenSource } from '@/media/nativeScreen';
import {
  cachePreview,
  cancelPreview,
  enqueuePreview,
  isCompleteJpeg,
  thumbnailBytes,
  PREVIEW_MAX_AGE_MS,
  type PreviewCache,
} from './previewQueue';

/**
 * A still thumbnail of one capture source, fetched only once the tile scrolls
 * into view. A cached frame paints immediately; anything older is re-requested.
 */
export default function SourcePreview({
  source,
  cache,
  revision,
}: {
  source: NativeScreenSource;
  cache: PreviewCache;
  revision: number;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState('');
  const [failure, setFailure] = useState('');

  useEffect(() => {
    let alive = true;
    let queued = false;
    let started = false;
    let objectUrl = '';
    setFailure('');
    setUrl('');

    const request = async () => {
      if (!alive) return;
      started = true;
      try {
        const bytes = thumbnailBytes(
          await invoke<unknown>('native_screen_thumbnail', { sourceId: source.id }),
        );
        if (!alive) return;
        if (!isCompleteJpeg(bytes))
          throw new Error('Native preview returned an incomplete JPEG');
        const blob = new Blob([Uint8Array.from(bytes).buffer], { type: 'image/jpeg' });
        cachePreview(cache, source.id, blob);
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setFailure('');
      } catch (cause) {
        if (alive) setFailure(errorMessage(cause));
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (started) return;
        if (!entries.some((entry) => entry.isIntersecting)) {
          cancelPreview(request);
          queued = false;
          return;
        }
        if (queued) return;
        const cached = cache.get(source.id);
        if (cached && Date.now() - cached.at < PREVIEW_MAX_AGE_MS) {
          objectUrl = URL.createObjectURL(cached.blob);
          setUrl(objectUrl);
          observer.disconnect();
          return;
        }
        cache.delete(source.id);
        queued = true;
        enqueuePreview(request);
      },
      { root: element.current?.closest('.share-source-scroll'), rootMargin: '0px' },
    );
    if (element.current) observer.observe(element.current);
    return () => {
      alive = false;
      observer.disconnect();
      cancelPreview(request);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source.id, cache, revision]);

  return (
    <span ref={element} className="share-source-preview">
      {url ? (
        <img
          src={url}
          alt=""
          onError={() => {
            setUrl('');
            setFailure('The native preview image could not be displayed');
          }}
        />
      ) : (
        <span className="share-preview-placeholder">
          {source.kind === 'monitor' ? <Monitor size={30} /> : <PanelsTopLeft size={30} />}
          <small title={failure}>
            {failure
              ? source.minimized
                ? 'Minimized · restore the app for a preview'
                : 'Preview unavailable · refresh sources above'
              : 'Loading preview…'}
          </small>
        </span>
      )}
    </span>
  );
}
