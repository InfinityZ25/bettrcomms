import { useCallback, useEffect, useState } from 'react';
import { screenKey, shareIdOf, type ScreenShare, type StageItem } from './stageItems';

/**
 * Which screens are being watched and which item, if any, is on the stage alone.
 *
 * Both are keyed by share id, so a sender who restarts a capture keeps their
 * place, and both are pruned as soon as a share disappears.
 */
export function useStageSelection(shares: ScreenShare[], availableItems: StageItem[]) {
  const [watchedShareIds, setWatchedShareIds] = useState<string[]>([]);
  const [focusedStageKey, setFocusedStageKey] = useState<string | null>(null);

  const shareSignature = shares.map(({ id, track }) => `${id}:${track.id}`).join('|');
  useEffect(() => {
    const available = new Set(shares.map(({ id }) => id));
    // Your own share is watched the moment it starts; everyone else's is opt-in.
    setWatchedShareIds((current) => {
      const next = current.filter((id) => available.has(id));
      if (available.has('local') && !next.includes('local')) next.unshift('local');
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
    setFocusedStageKey((current) =>
      !current?.startsWith('screen:') || available.has(shareIdOf(current)) ? current : null,
    );
  }, [shareSignature]);

  const clearSelection = useCallback(() => {
    setWatchedShareIds((current) => (current.length ? [] : current));
    setFocusedStageKey(null);
  }, []);

  const toggleWatchedShare = useCallback((id: string) => {
    setWatchedShareIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
    setFocusedStageKey((current) => (current === screenKey(id) ? null : current));
  }, []);

  const focusShare = useCallback((id: string) => {
    setWatchedShareIds((current) => (current.includes(id) ? current : [...current, id]));
    setFocusedStageKey(screenKey(id));
  }, []);

  const focusedStageItem = availableItems.find((item) => item.key === focusedStageKey);
  const watchedScreens = availableItems.filter(
    (item) => item.kind === 'screen' && watchedShareIds.includes(shareIdOf(item.key)),
  );

  return {
    watchedShareIds,
    focusedStageKey,
    setFocusedStageKey,
    focusedStageItem,
    watchedScreens,
    toggleWatchedShare,
    focusShare,
    clearSelection,
  };
}
