import { memo, useCallback, useSyncExternalStore } from 'react';
import { Blobatar } from '@blobatar/react';
import type { CharacterAppearance } from '@/api';
import { cn } from '@/lib/utils';
import { blobatarFor } from '@/features/settings/blobatarIdentity';
import { characterSnapshot, subscribeCharacter } from '@/features/settings/characterStore';
import { scheduleCompanionMotion, companionMotionSnapshot, subscribeCompanionMotion, type CompanionGestureKind } from '@/features/settings/companionMotion';
import './companion.css';

export type { CompanionGestureKind } from '@/features/settings/companionMotion';
export type CompanionProps = {
  userId?: string;
  name: string;
  character?: CharacterAppearance;
  /** Only local, unsaved profile previews override the versioned account snapshot. */
  preview?: boolean;
  speaking?: boolean;
  arrivalId?: string;
  arrivalAt?: number;
  gesture?: { id: string; kind: CompanionGestureKind };
  className?: string;
};

/** A static figure with event-driven movement on its wrapper, never an audio renderer. */
export const Companion = memo(function Companion({ userId, name, character, preview = false, speaking = false, arrivalId, arrivalAt, gesture, className }: CompanionProps) {
  const key = userId ?? name;
  const subscribe = useCallback((listener: () => void) => subscribeCharacter(key, listener), [key]);
  const snapshot = useCallback(() => characterSnapshot(key), [key]);
  const stored = useSyncExternalStore(subscribe, snapshot, snapshot);
  const motion = useSyncExternalStore(subscribeCompanionMotion, companionMotionSnapshot, companionMotionSnapshot);
  const face = blobatarFor(key, preview ? character : stored ?? character);
  const gestureId = gesture?.id;
  const gestureKind = gesture?.kind;
  const ref = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    return scheduleCompanionMotion(node, { arrivalId, arrivalAt, gesture: gestureId && gestureKind ? { id: gestureId, kind: gestureKind } : undefined });
  }, [arrivalId, arrivalAt, gestureId, gestureKind]);
  return (
    <span
      ref={ref}
      className={cn('companion', className)}
      role="img"
      aria-label={`${name}'s character`}
      data-companion-user={userId}
      data-character-seed={face.name}
      data-character-hue={face.hue}
      data-speaking={speaking && motion.enabled}
    >
      <span className="companion-figure">
        <Blobatar name={face.name} hue={face.hue} aria-hidden="true" className="size-full" />
      </span>
    </span>
  );
});
