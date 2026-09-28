import type {
  Capability,
  DesktopCapabilityName,
  DesktopMediaCapabilities,
  DesktopRuntime,
} from './types';
import { getDesktopRuntime, readDesktopBootReport } from './runtime';

/**
 * Honest capability reporting for the current host.
 *
 * A capability is reported working only where its code actually runs. Wails
 * injects its report before the page loads; a browser reports browser media.
 *
 * No function here may return `implemented` for a native capability on the
 * strength of another host's tests.
 */

const BROWSER_FALLBACKS: Record<DesktopCapabilityName, string> = {
  browserMedia: '',
  nativeGameVideo: 'browser getDisplayMedia screen and window sharing',
  nativeProcessAudio:
    'browser display-capture audio, with the scope the browser chooses',
  nativeMicrophoneDsp:
    'browser RNNoise, SpeexDSP, DeepFilterNet WASM, or standard webview processing',
  localTrackRecording:
    'browser MediaRecorder into the local recording library, with browser export',
  mediaPermissions: 'the browser or webview permission prompt',
  globalInput: 'foreground push-to-talk from page key events',
  nativeOverlays: 'in-app presentation inside the call stage',
};

function unavailable(
  name: DesktopCapabilityName,
  detail: string,
): Capability {
  return { state: 'unavailable', detail, fallback: BROWSER_FALLBACKS[name] };
}

/** The report for a plain browser, where no host is present at all. */
export function browserCapabilities(): DesktopMediaCapabilities {
  const detail = 'This is a browser tab; no desktop host is present.';
  return {
    schemaVersion: 1,
    platform: 'browser',
    architecture: 'unknown',
    browserMedia: {
      state: 'implemented',
      detail:
        'getUserMedia and getDisplayMedia are the browser’s own; device and codec support must be probed at use.',
    },
    nativeGameVideo: unavailable('nativeGameVideo', detail),
    nativeProcessAudio: unavailable('nativeProcessAudio', detail),
    nativeMicrophoneDsp: unavailable('nativeMicrophoneDsp', detail),
    localTrackRecording: unavailable('localTrackRecording', detail),
    mediaPermissions: unavailable('mediaPermissions', detail),
    globalInput: unavailable('globalInput', detail),
    nativeOverlays: unavailable('nativeOverlays', detail),
    notes: ['browser clients use browser media for every source'],
  };
}

/**
 * The capability report available without waiting for a round trip.
 *
 * The Wails host injects its report into the document before rendering.
 */
export function getDesktopCapabilities(): DesktopMediaCapabilities {
  const boot = readDesktopBootReport();
  if (boot) return boot.capabilities;
  return browserCapabilities();
}

/** The current host's capability report. */
export async function loadDesktopCapabilities(): Promise<DesktopMediaCapabilities> {
  return getDesktopCapabilities();
}

/** True when a capability is genuinely available on this host right now. */
export function hasDesktopCapability(name: DesktopCapabilityName): boolean {
  return getDesktopCapabilities()[name].state === 'implemented';
}

/**
 * What the user gets for a capability the host does not have. Empty when the
 * capability is available, so callers can use it directly as help text.
 */
export function describeCapabilityFallback(
  name: DesktopCapabilityName,
): string {
  const capability = getDesktopCapabilities()[name];
  if (capability.state === 'implemented') return '';
  return capability.fallback ?? BROWSER_FALLBACKS[name];
}

/** A compact runtime summary for diagnostic reports. Carries no identifiers. */
export function describeDesktopRuntime(): {
  runtime: DesktopRuntime;
  hostVersion: string;
  platform: string;
  architecture: string;
  capabilities: Record<DesktopCapabilityName, string>;
  apiOriginError?: string;
} {
  const boot = readDesktopBootReport();
  const capabilities = getDesktopCapabilities();
  const states = {} as Record<DesktopCapabilityName, string>;
  for (const name of Object.keys(BROWSER_FALLBACKS) as DesktopCapabilityName[]) {
    states[name] = capabilities[name].state;
  }
  return {
    runtime: getDesktopRuntime(),
    hostVersion: boot?.hostVersion ?? '',
    platform: capabilities.platform,
    architecture: capabilities.architecture,
    capabilities: states,
    apiOriginError: boot?.apiOriginError,
  };
}
