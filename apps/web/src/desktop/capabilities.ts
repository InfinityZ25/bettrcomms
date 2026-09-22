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
 * The rule this file exists to enforce: a capability is reported working only
 * where its code actually runs. The Wails host has none of the native media
 * adapters, so it reports them unavailable together with the browser path used
 * instead. The Tauri host answers for itself through IPC. A browser reports the
 * browser.
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
 * The Wails host injects its report into the document, so it is exact. The
 * Tauri host answers asynchronously, so this returns a conservative view for it
 * and callers that need the real one await {@link loadDesktopCapabilities}.
 */
export function getDesktopCapabilities(): DesktopMediaCapabilities {
  const boot = readDesktopBootReport();
  if (boot) return boot.capabilities;
  if (getDesktopRuntime() === 'tauri') return pendingTauriCapabilities();
  return browserCapabilities();
}

/**
 * The Tauri view before its report arrives. Every native capability is reported
 * unavailable while unknown: showing a native control that then fails is worse
 * than showing the browser path and upgrading once the host has answered.
 */
function pendingTauriCapabilities(): DesktopMediaCapabilities {
  const detail =
    'The Tauri host has not reported yet; the browser path applies until it does.';
  return {
    ...browserCapabilities(),
    platform: 'tauri-pending',
    nativeGameVideo: unavailable('nativeGameVideo', detail),
    nativeProcessAudio: unavailable('nativeProcessAudio', detail),
    nativeMicrophoneDsp: unavailable('nativeMicrophoneDsp', detail),
    localTrackRecording: unavailable('localTrackRecording', detail),
    mediaPermissions: unavailable('mediaPermissions', detail),
    globalInput: unavailable('globalInput', detail),
    nativeOverlays: unavailable('nativeOverlays', detail),
  };
}

/**
 * The host's own capability report.
 *
 * Wails answers from the injected report. Tauri answers through
 * `desktop_media_capabilities`, whose schema covers four of these capabilities;
 * the rest keep an explicit "not reported by this host" state rather than a
 * guess in either direction, because the Tauri feature modules probe the host
 * directly for those and this report must not contradict them.
 */
export async function loadDesktopCapabilities(): Promise<DesktopMediaCapabilities> {
  if (getDesktopRuntime() !== 'tauri') return getDesktopCapabilities();

  const notReported =
    'This host does not include the capability in its report schema; the feature probes it directly.';
  const base: DesktopMediaCapabilities = {
    ...pendingTauriCapabilities(),
    nativeMicrophoneDsp: unavailable('nativeMicrophoneDsp', notReported),
    mediaPermissions: unavailable('mediaPermissions', notReported),
    globalInput: unavailable('globalInput', notReported),
    nativeOverlays: unavailable('nativeOverlays', notReported),
  };

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const reported = await invoke<Partial<DesktopMediaCapabilities>>(
      'desktop_media_capabilities',
    );
    return {
      ...base,
      platform: reported.platform ?? base.platform,
      architecture: reported.architecture ?? base.architecture,
      browserMedia: reported.browserMedia ?? base.browserMedia,
      nativeGameVideo: reported.nativeGameVideo ?? base.nativeGameVideo,
      nativeProcessAudio: reported.nativeProcessAudio ?? base.nativeProcessAudio,
      localTrackRecording:
        reported.localTrackRecording ?? base.localTrackRecording,
      notes: reported.notes ?? base.notes,
    };
  } catch {
    // An older host without the command keeps the conservative report.
    return base;
  }
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
