import { isTauri } from '@tauri-apps/api/core';
import type {
  Capability,
  CapabilityState,
  DesktopBootReport,
  DesktopMediaCapabilities,
  DesktopRuntime,
  DesktopWindowControls,
} from './types';

/**
 * Which desktop shell, if any, is hosting this page.
 *
 * Detection is synchronous on purpose: the title bar and several media modules
 * have to decide before their first render, and an async probe would flash the
 * wrong layout. Tauri publishes its own marker, and the Wails host injects the
 * global below into the document it serves. Neither is inferred from the user
 * agent, which a WebView shares with an ordinary browser.
 */

const BOOT_GLOBAL = '__BETTERCOMMS_DESKTOP__';

type WindowWithBoot = Window & { [BOOT_GLOBAL]?: unknown };

let cached: DesktopBootReport | null | undefined;

/** Clears the memoised boot report. Tests use this; product code does not. */
export function resetDesktopRuntimeCache() {
  cached = undefined;
}

/**
 * The validated Wails boot report, or null.
 *
 * The global arrives from an injected script, so it is validated rather than
 * trusted. A malformed report is discarded whole: partially believing it could
 * point API traffic at an attacker's origin or leave a frameless window with no
 * close button.
 */
export function readDesktopBootReport(): DesktopBootReport | null {
  if (cached !== undefined) return cached;
  cached = parseBootReport(
    typeof window === 'undefined'
      ? undefined
      : (window as WindowWithBoot)[BOOT_GLOBAL],
  );
  return cached;
}

export function getDesktopRuntime(): DesktopRuntime {
  if (readDesktopBootReport()) return 'wails';
  // isTauri() reads a marker Tauri sets on the window before the page loads.
  try {
    if (isTauri()) return 'tauri';
  } catch {
    // A stubbed or absent Tauri global is simply not a Tauri host.
  }
  return 'browser';
}

/** True inside either desktop shell. Use this for shell chrome, not features. */
export function isDesktopShell(): boolean {
  return getDesktopRuntime() !== 'browser';
}

/**
 * True only where the Tauri native command table exists.
 *
 * Every native media adapter — capture, process audio, GPU denoisers, native
 * recording, global input, overlays — lives in the Tauri host alone. Feature
 * code must gate on this, not on `isDesktopShell()`.
 */
export function hasTauriNativeCommands(): boolean {
  return getDesktopRuntime() === 'tauri';
}

/**
 * The API origin the host wants the web client to use, or null to keep the
 * page's own origin. Only the Wails host reports one synchronously; the Tauri
 * host answers the equivalent `desktop_boot_config` command asynchronously.
 */
export function getDesktopApiOrigin(): string | null {
  const boot = readDesktopBootReport();
  return boot && boot.apiOrigin ? boot.apiOrigin : null;
}

function parseBootReport(value: unknown): DesktopBootReport | null {
  if (!isRecord(value)) return null;
  if (value.runtime !== 'wails') return null;
  if (typeof value.schemaVersion !== 'number' || value.schemaVersion !== 1) {
    return null;
  }
  const capabilities = parseCapabilities(value.capabilities);
  const windowControls = parseWindowControls(value.windowControls);
  const authReturn = parseCapability(value.authReturn);
  if (!capabilities || !windowControls || !authReturn) return null;

  const apiOrigin = parseApiOrigin(value.apiOrigin);
  if (apiOrigin === null) return null;

  return {
    schemaVersion: 1,
    runtime: 'wails',
    hostVersion: asString(value.hostVersion),
    platform: asString(value.platform),
    architecture: asString(value.architecture),
    apiOrigin,
    apiOriginError:
      typeof value.apiOriginError === 'string'
        ? value.apiOriginError
        : undefined,
    authReturn,
    windowControls,
    capabilities,
  };
}

/**
 * Re-validates the origin the host sent. The host already applied its policy,
 * but this value decides where session cookies and tokens go, so the page
 * checks it again rather than inheriting the decision: an empty origin (keep
 * the page's own) is fine, anything unparseable or carrying a path, query,
 * fragment, or credentials is a rejected report.
 */
function parseApiOrigin(value: unknown): string | null {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return null;
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    return null;
  }
  return url.origin;
}

const CAPABILITY_NAMES = [
  'browserMedia',
  'nativeGameVideo',
  'nativeProcessAudio',
  'nativeMicrophoneDsp',
  'localTrackRecording',
  'mediaPermissions',
  'globalInput',
  'nativeOverlays',
] as const;

function parseCapabilities(value: unknown): DesktopMediaCapabilities | null {
  if (!isRecord(value)) return null;
  const parsed = {} as Record<(typeof CAPABILITY_NAMES)[number], Capability>;
  for (const name of CAPABILITY_NAMES) {
    const capability = parseCapability(value[name]);
    if (!capability) return null;
    parsed[name] = capability;
  }
  return {
    schemaVersion: 1,
    platform: asString(value.platform),
    architecture: asString(value.architecture),
    notes: Array.isArray(value.notes)
      ? value.notes.filter((note): note is string => typeof note === 'string')
      : [],
    ...parsed,
  };
}

function parseCapability(value: unknown): Capability | null {
  if (!isRecord(value)) return null;
  const states: CapabilityState[] = [
    'implemented',
    'experimental',
    'unavailable',
  ];
  if (!states.includes(value.state as CapabilityState)) return null;
  return {
    state: value.state as CapabilityState,
    detail: asString(value.detail),
    fallback: typeof value.fallback === 'string' ? value.fallback : undefined,
  };
}

function parseWindowControls(value: unknown): DesktopWindowControls | null {
  if (!isRecord(value)) return null;
  const platforms = ['windows', 'macos', 'linux', 'unknown'];
  const modes = [
    'native-frame',
    'native-overlay',
    'native-traffic-lights',
    'client-side',
  ];
  const buttons = ['minimize', 'maximize', 'close'];
  if (
    !platforms.includes(value.platform as string) ||
    !modes.includes(value.mode as string) ||
    !isSize(value.height) ||
    !isSize(value.insetStart) ||
    !isSize(value.insetEnd) ||
    !['start', 'end'].includes(value.buttonSide as string) ||
    !Array.isArray(value.buttons) ||
    !value.buttons.every((button) => buttons.includes(button as string))
  ) {
    return null;
  }
  return value as unknown as DesktopWindowControls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
