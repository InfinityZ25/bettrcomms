import { useCallback, useState } from 'react';
import { readStoredOption, writeStored } from '@/lib/storage';
import { galleryLayouts, type GalleryLayout } from './stageItems';

/** How the call arranges its tiles. Each choice persists on this device. */
export function useGalleryPreferences(onLayoutChange: (layout: GalleryLayout) => void) {
  const [galleryLayout, setGalleryLayoutState] = useState<GalleryLayout>(() =>
    readStoredOption('bc-gallery-layout', galleryLayouts, 'adaptive'),
  );
  const [galleryFit, setGalleryFitState] = useState(() =>
    readStoredOption('bc-gallery-fit', ['cover', 'contain'] as const, 'cover'),
  );
  const [contentFit, setContentFitState] = useState(() =>
    readStoredOption('bc-content-fit', ['fit', 'fill'] as const, 'fit'),
  );

  const setGalleryLayout = useCallback(
    (value: GalleryLayout) => {
      setGalleryLayoutState(value);
      onLayoutChange(value);
      writeStored('bc-gallery-layout', value);
    },
    [onLayoutChange],
  );

  const toggleGalleryFit = useCallback(() => {
    setGalleryFitState((current) => {
      const next = current === 'cover' ? 'contain' : 'cover';
      writeStored('bc-gallery-fit', next);
      return next;
    });
  }, []);

  const toggleContentFit = useCallback(() => {
    setContentFitState((current) => {
      const next = current === 'fit' ? 'fill' : 'fit';
      writeStored('bc-content-fit', next);
      return next;
    });
  }, []);

  return {
    galleryLayout,
    setGalleryLayout,
    galleryFit,
    toggleGalleryFit,
    contentFit,
    toggleContentFit,
  };
}
