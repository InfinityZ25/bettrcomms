/**
 * The dual-runtime desktop bridge.
 *
 * One frontend serves three hosts: a browser tab, the Tauri 2 shell in
 * `apps/desktop`, and the Wails v3 shell in `apps/desktop-wails`. Import from
 * here rather than from `@tauri-apps/api` when the question is "which shell am
 * I in" or "does this host have that capability".
 *
 * Native media features remain Tauri-only. Gate them with
 * `hasTauriNativeCommands()`, and use the capability helpers to tell the user
 * what runs instead everywhere else.
 */
export {
  apiAuthHeaders,
  apiCredentials,
  apiHttpUrl,
  apiSocketUrl,
} from './apiTransport';

export {
  getDesktopApiOrigin,
  getDesktopApiTransport,
  getDesktopRuntime,
  hasTauriNativeCommands,
  isDesktopShell,
  readDesktopBootReport,
  resetDesktopRuntimeCache,
} from './runtime';

export {
  DesktopUnavailableError,
  dragRegionStyle,
  getDesktopSignInApi,
  getDesktopWindowApi,
  nativeNonClientRegion,
  noDragStyle,
  type DesktopSignInApi,
  type DesktopWindowApi,
} from './bridge';

export {
  resetWailsFrontendRuntime,
  startWailsFrontendRuntime,
} from './wailsFrontendRuntime';

export {
  browserCapabilities,
  describeCapabilityFallback,
  describeDesktopRuntime,
  getDesktopCapabilities,
  hasDesktopCapability,
  loadDesktopCapabilities,
} from './capabilities';

export type {
  Capability,
  CapabilityState,
  DesktopBootReport,
  DesktopCapabilityName,
  DesktopMediaCapabilities,
  DesktopRuntime,
  DesktopSignInState,
  DesktopSignInStatus,
  DesktopWindowControls,
} from './types';
