/**
 * One frontend serves a browser tab and the Wails v3 desktop host. Import
 * here for the current runtime and its reported native capabilities.
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
