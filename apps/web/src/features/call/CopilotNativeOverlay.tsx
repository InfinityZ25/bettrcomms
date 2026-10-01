import { useEffectEvent } from 'react';
import type { VisualCopilot } from '@/media/visualCopilot';
import { attachCopilotOverlay } from '@/media/copilotOverlay';
import { useMountEffect } from '@/hooks/useMountEffect';

/** Owned by the call provider, so navigating away from the stage preserves overlays. */
export function CopilotNativeOverlay({ copilot, names }: { copilot: VisualCopilot; names: Record<string, string> }) {
  const readNames = useEffectEvent(() => names);
  useMountEffect(() => attachCopilotOverlay(copilot, readNames));
  return null;
}
