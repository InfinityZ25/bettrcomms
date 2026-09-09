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

/** The window-control contract, identical to the one better-gui publishes. */
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
  authReturn: Capability;
  windowControls: DesktopWindowControls;
  capabilities: DesktopMediaCapabilities;
}
