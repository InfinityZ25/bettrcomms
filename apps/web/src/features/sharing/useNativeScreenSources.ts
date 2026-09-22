import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invokeNativeCapture as invoke } from '@/desktop/capture';
import type {
  NativeScreenCapabilities,
  NativeScreenSource,
  NativeScreenStartOptions,
} from '@/media/nativeScreen';
import type { NativeSystemAudioCapabilities } from '@/media/nativeSystemAudio';
import type { PreviewCache } from './previewQueue';

/**
 * What this machine can capture: the window and monitor list, the encoders the
 * native side offers, and whether it can capture audio.
 *
 * Every refresh carries a generation so a slow enumeration cannot overwrite a
 * newer one, and cached thumbnails are only discarded on an explicit refresh.
 */
export function useNativeScreenSources(onClose: () => void) {
  const alive = useRef(true);
  const generation = useRef(0);
  const previewCache = useRef<PreviewCache>(new Map());
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const [sources, setSources] = useState<NativeScreenSource[]>([]);
  const [capabilities, setCapabilities] = useState<NativeScreenCapabilities | null>(null);
  const [audioCaps, setAudioCaps] = useState<NativeSystemAudioCapabilities | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [sourceId, setSourceId] = useState('');
  const [tab, setTab] = useState<'window' | 'monitor'>('window');
  const [query, setQuery] = useState('');
  const [encoder, setEncoder] = useState<NativeScreenStartOptions['encoder']>('libx264');
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState('');

  const refreshSources = useCallback(async (resetPreviews = false) => {
    const current = ++generation.current;
    setRefreshing(true);
    setError('');
    try {
      const result = await invoke<{ sources: NativeScreenSource[] }>('native_screen_sources');
      if (!alive.current || current !== generation.current) return;
      if (resetPreviews) {
        previewCache.current.clear();
        setPreviewRevision((value) => value + 1);
      }
      setSources(result.sources);
      setSourceId((id) => (result.sources.some((source) => source.id === id) ? id : ''));
    } catch (cause) {
      if (alive.current && current === generation.current) setError(String(cause));
    } finally {
      if (alive.current && current === generation.current) setRefreshing(false);
    }
  }, []);

  const refreshCapabilities = useCallback(async () => {
    const caps = await invoke<NativeScreenCapabilities>('native_screen_capabilities');
    if (!alive.current) return;
    setCapabilities(caps);
    setEncoder(caps.encoders.find((item) => item.available)?.id ?? 'libx264');
    setError('');
  }, []);

  useEffect(() => {
    alive.current = true;
    let current = true;
    void invoke<NativeSystemAudioCapabilities>('native_system_audio_capabilities')
      .then((caps) => {
        if (current) setAudioCaps(caps);
      })
      .catch(() => {
        if (current)
          setAudioCaps({
            available: false,
            detail: 'System audio is unavailable in this desktop build.',
          });
      });
    void refreshSources();
    void refreshCapabilities().catch((cause) => {
      if (current) setError(String(cause));
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', keydown);
    return () => {
      alive.current = false;
      current = false;
      generation.current++;
      document.removeEventListener('keydown', keydown);
    };
  }, [refreshSources, refreshCapabilities]);

  const visible = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.kind === tab && source.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [sources, tab, query],
  );

  const chooseTab = (next: 'window' | 'monitor') => {
    setTab(next);
    setQuery('');
  };

  return {
    alive,
    previewCache,
    previewRevision,
    visible,
    selected: sources.find((source) => source.id === sourceId),
    sourceId,
    setSourceId,
    tab,
    chooseTab,
    query,
    setQuery,
    capabilities,
    audioCaps,
    encoder,
    setEncoder,
    refreshing,
    error,
    setError,
    refreshSources,
    refreshCapabilities,
  };
}
