import { allowDesktopCapture } from '@/media/permissions';
import { errorMessage } from '@/lib/errors';

export type PermissionKind = 'microphone' | 'camera';

/** Names the device in the message, because a denial reads the same either way. */
export function deviceError(error: unknown, kind?: PermissionKind) {
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  )
    return `${kind === 'camera' ? 'Camera' : 'Microphone'} access was denied. Allow it in your browser or system privacy settings, then try again.`;
  return errorMessage(error);
}

/** A denial is the one failure the desktop app can offer a way out of. */
export const isDenied = (status: string) => /denied|privacy settings/i.test(status);

export async function ensureDesktopPermission(kind: PermissionKind) {
  await allowDesktopCapture(kind);
}

export function closeContext(context: AudioContext | null) {
  if (context && context.state !== 'closed') void context.close().catch(() => {});
}
