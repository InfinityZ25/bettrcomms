/**
 * The contract shared by both desktop hosts.
 *
 * `apps/desktop` (Tauri 2) exposes it through IPC commands; `apps/desktop-wails`
 * (Wails v3) exposes commands through generated bindings and injects a boot
 * report into the document. The frontend reads one shape either way, so no
 * feature has to know which shell it is running inside.
 */

export type DesktopRuntime = 'tauri' | 'wails' | 'browser';

/**
 * `implemented` means the host has the code path and it is covered by tests.
 * `experimental` means it exists but has not met its acceptance gate.
 * `unavailable` means the host has no such code path at all.
 */
export type CapabilityState = 'implemented' | 'experimental' | 'unavailable';

export interface Capability {
  state: CapabilityState;
  /** Why it is in this state, in words a user can read. */
  detail: string;
  /** What the frontend does instead while the state is `unavailable`. */
  fallback?: string;
}

/** The media capabilities a desktop host reports about itself. */
export interface DesktopMediaCapabilities {
  schemaVersion: number;
  platform: string;
  architecture: string;
  browserMedia: Capability;
  nativeGameVideo: Capability;
  nativeProcessAudio: Capability;
  nativeMicrophoneDsp: Capability;
  localTrackRecording: Capability;
  mediaPermissions: Capability;
  globalInput: Capability;
  nativeOverlays: Capability;
  notes: string[];
}

/** The names a feature can ask about. */
export type DesktopCapabilityName = Exclude<
  keyof DesktopMediaCapabilities,
  'schemaVersion' | 'platform' | 'architecture' | 'notes'
>;

/** Shared window-control description for the desktop hosts. */
export interface DesktopWindowControls {
  platform: 'windows' | 'macos' | 'linux' | 'unknown';
  mode:
    | 'native-frame'
    | 'native-overlay'
    | 'native-traffic-lights'
    | 'client-side';
  height: number;
  insetStart: number;
  insetEnd: number;
  buttons: ('minimize' | 'maximize' | 'close')[];
  buttonSide: 'start' | 'end';
}

/**
 * The report the Wails host injects into the document before any bundle runs.
 * It is validated on read: a half-written or hostile value must not be able to
 * redirect API traffic or hide the window controls.
 */
export interface DesktopBootReport {
  schemaVersion: number;
  runtime: 'wails';
  hostVersion: string;
  platform: string;
  architecture: string;
  /** Validated API origin, or '' when the host could not resolve one. */
  apiOrigin: string;
  /** Present instead of a silent fallback when apiOrigin is empty. */
  apiOriginError?: string;
  /**
   * Loopback origin this host proxies the API through in a packaged build.
   * Absent in development and in the browser, where /api is already same-origin.
   */
  apiBase?: string;
  /** Per-launch secret authorising requests to apiBase. */
  apiToken?: string;
  /**
   * The per-launch secret a native call must present to prove it came from a
   * document this host served. It stands in for the per-call origin check the
   * Tauri host makes, which the Wails host cannot make.
   */
  pageToken?: string;
  authReturn: Capability;
  windowControls: DesktopWindowControls;
  capabilities: DesktopMediaCapabilities;
}

/** The stage a browser sign-in hand-off has reached on the desktop host. */
export type DesktopSignInState = 'idle' | 'waiting' | 'complete' | 'failed';

/**
 * What the host reports while sign-in runs in the system browser.
 *
 * The page never sees the pairing, the verifier, or the session: those stay in
 * the host process. It shows the code, waits, and reloads its session when the
 * host says it has one.
 */
export interface DesktopSignInStatus {
  state: DesktopSignInState;
  /** The code the browser page displays, for the person to compare. */
  code?: string;
  /** The confirmation address, offered when the browser did not open. */
  confirmUrl?: string;
  detail: string;
  /** When the attempt stops being claimable, in Unix milliseconds. */
  expiresAt?: number;
}
